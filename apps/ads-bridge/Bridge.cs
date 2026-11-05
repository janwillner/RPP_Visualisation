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

/// <summary>
/// Address and type information of one resolved symbol, with its counted arrays and how many entries of each the next
/// read fetches (from the previous count; see <see cref="ReadPlan"/>).
/// </summary>
internal sealed record ResolvedSymbol(
    uint IndexGroup,
    uint IndexOffset,
    int ByteSize,
    string TypeName,
    IDataType? DataType,
    IReadOnlyList<CountedArray> CountedArrays,
    int[] EntriesToRead)
{
    /// <summary>
    /// The symbol's bytes, kept from read to read: a register of a few hundred KB is not allocated anew every cycle.
    /// Every byte the conversion uses is read again each time; entries beyond a count may be stale but are never used.
    /// </summary>
    public byte[] Buffer { get; } = new byte[ByteSize];
}

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
        // Check the error first: an unreachable target (no route, runtime stopped) also leaves the symbol null.
        if (error == AdsErrorCode.DeviceSymbolNotFound) return null;
        if (error != AdsErrorCode.NoError) throw new AdsErrorException($"Reading symbol {path} failed", error);
        if (symbol == null) return null;
        Loader().DataTypes.TryGetType(symbol.TypeName, out IDataType? dataType);
        var arrays = ReadPlan.CountedArrays(symbol.IndexGroup, dataType);
        // The first read takes the reserve only; it learns the counts.
        var entries = arrays.Select(a => ReadPlan.WithReserve(0, a.Capacity)).ToArray();
        var resolved = new ResolvedSymbol(symbol.IndexGroup, symbol.IndexOffset, symbol.ByteSize, symbol.TypeName, dataType, arrays, entries);
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
        var buffers = symbols.Select(s => s.Buffer).ToList();

        // One sum-read: each symbol whole, its counted arrays as far as the previous count plus a reserve.
        var parts = new List<(int Symbol, Segment Segment)>();
        for (int i = 0; i < symbols.Count; i++)
        {
            foreach (var segment in ReadPlan.Segments(symbols[i].ByteSize, symbols[i].CountedArrays, symbols[i].EntriesToRead))
                parts.Add((i, segment));
        }
        ReadParts(symbols, buffers, parts, paths);

        // Entries counted beyond what was read (many added at once) follow in a second sum-read.
        var missing = new List<(int Symbol, Segment Segment)>();
        for (int i = 0; i < symbols.Count; i++)
        {
            var arrays = symbols[i].CountedArrays;
            for (int k = 0; k < arrays.Count; k++)
            {
                var a = arrays[k];
                int count = a.CountIn(buffers[i]);
                int read = symbols[i].EntriesToRead[k];
                if (count > read) missing.Add((i, new Segment(a.Offset + read * a.ElementSize, (count - read) * a.ElementSize)));
                symbols[i].EntriesToRead[k] = ReadPlan.WithReserve(count, a.Capacity);
            }
        }
        if (missing.Count > 0) ReadParts(symbols, buffers, missing, paths);

        var result = new JsonArray();
        for (int i = 0; i < symbols.Count; i++) result.Add(ValueConverter.Convert(symbols[i], buffers[i]));
        return result;
    }

    /// <summary>A sum-read accepts at most this many reads.</summary>
    private const int MaxReadsPerSumRead = 500;

    /// <summary>Reads byte ranges of symbols into their buffers, in as few sum-reads as allowed.</summary>
    private void ReadParts(
        IReadOnlyList<ResolvedSymbol> symbols,
        IReadOnlyList<byte[]> buffers,
        IReadOnlyList<(int Symbol, Segment Segment)> parts,
        IReadOnlyList<string> paths)
    {
        for (int start = 0; start < parts.Count; start += MaxReadsPerSumRead)
        {
            int n = Math.Min(MaxReadsPerSumRead, parts.Count - start);
            // Request: per read (indexGroup, indexOffset, length). Response: per read an error code, then all data.
            var request = new byte[n * 12];
            int dataLength = 0;
            for (int j = 0; j < n; j++)
            {
                var (s, segment) = parts[start + j];
                var span = request.AsSpan(j * 12);
                BinaryPrimitives.WriteUInt32LittleEndian(span, symbols[s].IndexGroup);
                BinaryPrimitives.WriteUInt32LittleEndian(span[4..], symbols[s].IndexOffset + (uint)segment.Offset);
                BinaryPrimitives.WriteUInt32LittleEndian(span[8..], (uint)segment.Length);
                dataLength += segment.Length;
            }
            var response = new byte[n * 4 + dataLength];
            Client().ReadWrite(SumReadIndexGroup, (uint)n, response.AsMemory(), request.AsMemory());

            int offset = n * 4;
            for (int j = 0; j < n; j++)
            {
                var (s, segment) = parts[start + j];
                uint error = BinaryPrimitives.ReadUInt32LittleEndian(response.AsSpan(j * 4));
                if (error != 0) throw new InvalidOperationException($"ADS sum-read failed for {paths[s]}: error 0x{error:X}");
                response.AsSpan(offset, segment.Length).CopyTo(buffers[s].AsSpan(segment.Offset));
                offset += segment.Length;
            }
        }
    }
}
