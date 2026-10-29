using System.Buffers.Binary;
using System.Text.Json.Nodes;
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;

namespace AdsBridge;

public sealed record BridgeOptions(string AmsNetId, int AdsPort)
{
    public static BridgeOptions Parse(string[] args)
    {
        string netId = "127.0.0.1.1.1";
        int port = 851;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--ams-net-id") netId = args[i + 1];
            if (args[i] == "--ads-port") port = int.Parse(args[i + 1]);
        }
        return new BridgeOptions(netId, port);
    }
}

public sealed class SymbolNotFoundException(string path) : Exception($"Symbol not found: {path}");

/// <summary>Address and type information of one resolved symbol.</summary>
internal sealed record ResolvedSymbol(uint IndexGroup, uint IndexOffset, int ByteSize, string TypeName, IDataType? DataType);

/// <summary>Handles gateway requests against one ADS target. Not thread-safe; requests are processed in order.</summary>
public sealed class Bridge(BridgeOptions options) : IDisposable
{
    /// <summary>ADSIGRP_SUMUP_READ: several reads in one ADS request.</summary>
    private const uint SumReadIndexGroup = 0xF080;

    private AdsClient? _client;
    private ISymbolLoader? _loader;
    private readonly Dictionary<string, ResolvedSymbol> _symbols = new();
    private bool _symbolsChanged;

    public JsonNode? Handle(JsonObject request)
    {
        string op = request["op"]!.GetValue<string>();
        return op switch
        {
            "typeOf" => TypeOf(request["path"]!.GetValue<string>()),
            "read" => Read(request["path"]!.GetValue<string>()),
            "sumRead" => SumRead(request["paths"]!.AsArray().Select(p => p!.GetValue<string>()).ToList()),
            _ => throw new InvalidOperationException($"Unknown op '{op}'"),
        };
    }

    /// <summary>Drops the connection and all cached symbol information; the next request reconnects.</summary>
    public void Reset()
    {
        _symbols.Clear();
        _loader = null;
        _client?.Dispose();
        _client = null;
    }

    public void Dispose() => Reset();

    private AdsClient Client()
    {
        if (_client is { IsConnected: true }) return _client;
        Reset();
        var client = new AdsClient();
        client.Connect(AmsNetId.Parse(options.AmsNetId), options.AdsPort);
        client.AdsSymbolVersionChanged += (_, _) => _symbolsChanged = true;
        _client = client;
        return client;
    }

    private ISymbolLoader Loader()
    {
        _loader ??= SymbolLoaderFactory.Create(Client(), new SymbolLoaderSettings(SymbolsLoadMode.VirtualTree));
        return _loader;
    }

    private ResolvedSymbol? Resolve(string path)
    {
        if (_symbols.TryGetValue(path, out var cached)) return cached;
        var client = Client();
        var error = client.TryReadSymbol(path, out IAdsSymbol? symbol);
        if (error == AdsErrorCode.DeviceSymbolNotFound || symbol == null) return null;
        if (error != AdsErrorCode.NoError) throw new AdsErrorException($"Reading symbol {path} failed", error);
        Loader().DataTypes.TryGetType(symbol.TypeName, out IDataType? dataType);
        var resolved = new ResolvedSymbol(symbol.IndexGroup, symbol.IndexOffset, symbol.ByteSize, symbol.TypeName, dataType);
        _symbols[path] = resolved;
        return resolved;
    }

    private ResolvedSymbol Require(string path) => Resolve(path) ?? throw new SymbolNotFoundException(path);

    private JsonNode? TypeOf(string path) => Resolve(path)?.TypeName is { } name ? JsonValue.Create(name) : null;

    private JsonNode? Read(string path) => SumRead([path])[0]?.DeepClone();

    private JsonNode SumRead(IReadOnlyList<string> paths)
    {
        if (_symbolsChanged)
        {
            // Addresses may have moved after a download or online change: make the gateway rediscover.
            _symbolsChanged = false;
            Reset();
            throw new InvalidOperationException("PLC symbols changed (download or online change); rediscovering");
        }
        var symbols = paths.Select(Require).ToList();

        // Request: per entry (indexGroup, indexOffset, length). Response: per entry an error code, then all data.
        var request = new byte[symbols.Count * 12];
        int dataLength = 0;
        for (int i = 0; i < symbols.Count; i++)
        {
            var span = request.AsSpan(i * 12);
            BinaryPrimitives.WriteUInt32LittleEndian(span, symbols[i].IndexGroup);
            BinaryPrimitives.WriteUInt32LittleEndian(span[4..], symbols[i].IndexOffset);
            BinaryPrimitives.WriteUInt32LittleEndian(span[8..], (uint)symbols[i].ByteSize);
            dataLength += symbols[i].ByteSize;
        }
        var response = new byte[symbols.Count * 4 + dataLength];
        Client().ReadWrite(SumReadIndexGroup, (uint)symbols.Count, response.AsMemory(), request.AsMemory());

        var result = new JsonArray();
        int offset = symbols.Count * 4;
        for (int i = 0; i < symbols.Count; i++)
        {
            uint error = BinaryPrimitives.ReadUInt32LittleEndian(response.AsSpan(i * 4));
            if (error != 0) throw new InvalidOperationException($"ADS sum-read failed for {paths[i]}: error 0x{error:X}");
            result.Add(ValueConverter.Convert(symbols[i], response.AsSpan(offset, symbols[i].ByteSize).ToArray()));
            offset += symbols[i].ByteSize;
        }
        return result;
    }
}
