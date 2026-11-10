using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using TwinCAT.Ads;
using TwinCAT.Ads.TypeSystem;

namespace AdsBridge;

/// <summary>
/// Writes leaf values by symbol path in one ADS sum-write (ADR 0017). The sub-commands run in the order given, so the
/// PLC sees the last value (a parameter set's <c>bStaged</c>) only after all the others. An array index in a path counts
/// from 0, as in every value read; it is mapped to the array's lower bound from its type name (<c>ARRAY [1..8] OF</c>).
/// </summary>
internal static partial class SumWrite
{
    /// <summary>ADSIGRP_SUMUP_WRITE: several writes in one ADS request.</summary>
    private const uint SumWriteIndexGroup = 0xF081;

    /// <summary>One leaf to write: its address and its bytes.</summary>
    private sealed record Leaf(string Path, uint IndexGroup, uint IndexOffset, byte[] Data);

    [GeneratedRegex(@"\[(\d+)\]")]
    private static partial Regex IndexPattern();

    [GeneratedRegex(@"^\s*ARRAY\s*\[\s*(-?\d+)\s*\.\.", RegexOptions.IgnoreCase)]
    private static partial Regex LowerBoundPattern();

    public static void Run(AdsClient client, JsonArray writes)
    {
        var lowerBounds = new Dictionary<string, int>();
        var leaves = writes.Select(w =>
        {
            string path = w!["path"]!.GetValue<string>();
            string plcPath = PlcPath(client, path, lowerBounds);
            var error = client.TryReadSymbol(plcPath, out IAdsSymbol? symbol);
            if (error == AdsErrorCode.DeviceSymbolNotFound || (error == AdsErrorCode.NoError && symbol == null))
                throw new SymbolNotFoundException(path);
            if (error != AdsErrorCode.NoError) throw new AdsErrorException($"Reading symbol {plcPath} failed", error);
            return new Leaf(path, symbol!.IndexGroup, symbol.IndexOffset, Encode(symbol, w["value"]!, path));
        }).ToList();
        if (leaves.Count == 0) return;

        // Request: per write (indexGroup, indexOffset, length), then all data. Response: per write an error code.
        int dataLength = leaves.Sum(l => l.Data.Length);
        var request = new byte[leaves.Count * 12 + dataLength];
        int offset = leaves.Count * 12;
        for (int i = 0; i < leaves.Count; i++)
        {
            var span = request.AsSpan(i * 12);
            BinaryPrimitives.WriteUInt32LittleEndian(span, leaves[i].IndexGroup);
            BinaryPrimitives.WriteUInt32LittleEndian(span[4..], leaves[i].IndexOffset);
            BinaryPrimitives.WriteUInt32LittleEndian(span[8..], (uint)leaves[i].Data.Length);
            leaves[i].Data.CopyTo(request.AsSpan(offset));
            offset += leaves[i].Data.Length;
        }
        var response = new byte[leaves.Count * 4];
        client.ReadWrite(SumWriteIndexGroup, (uint)leaves.Count, response.AsMemory(), request.AsMemory());
        for (int i = 0; i < leaves.Count; i++)
        {
            uint error = BinaryPrimitives.ReadUInt32LittleEndian(response.AsSpan(i * 4));
            if (error != 0) throw new InvalidOperationException($"ADS sum-write failed for {leaves[i].Path}: error 0x{error:X}");
        }
    }

    /// <summary>The path with every array index moved from 0 to its array's lower bound.</summary>
    private static string PlcPath(AdsClient client, string path, Dictionary<string, int> lowerBounds)
    {
        var result = new StringBuilder();
        int last = 0;
        foreach (Match m in IndexPattern().Matches(path))
        {
            result.Append(path, last, m.Index - last);
            string array = result.ToString();
            if (!lowerBounds.TryGetValue(array, out int lower))
            {
                var error = client.TryReadSymbol(array, out IAdsSymbol? symbol);
                if (error != AdsErrorCode.NoError || symbol == null) throw new SymbolNotFoundException(path);
                var bound = LowerBoundPattern().Match(symbol.TypeName);
                lower = bound.Success ? int.Parse(bound.Groups[1].Value) : 0;
                lowerBounds[array] = lower;
            }
            result.Append('[').Append(int.Parse(m.Groups[1].Value) + lower).Append(']');
            last = m.Index + m.Length;
        }
        result.Append(path, last, path.Length - last);
        return result.ToString();
    }

    /// <summary>
    /// A JSON leaf value as the bytes of its symbol: a switch, a whole number (also an enumeration) of the symbol's size,
    /// a REAL or LREAL, or a STRING padded with zeros.
    /// </summary>
    private static byte[] Encode(IAdsSymbol symbol, JsonNode value, string path)
    {
        var bytes = new byte[symbol.ByteSize];
        string type = symbol.TypeName.Trim().ToUpperInvariant();
        var json = value.AsValue();
        if (json.TryGetValue(out bool flag))
        {
            if (bytes.Length > 0) bytes[0] = flag ? (byte)1 : (byte)0;
            return bytes;
        }
        if (json.TryGetValue(out string? text))
        {
            if (!type.StartsWith("STRING")) throw new InvalidOperationException($"{path} is {symbol.TypeName}, not a STRING");
            var encoded = Encoding.Latin1.GetBytes(text);
            // The last byte stays 0: the string's terminator.
            encoded.AsSpan(0, Math.Min(encoded.Length, bytes.Length - 1)).CopyTo(bytes);
            return bytes;
        }
        double number = json.GetValue<double>();
        switch (type)
        {
            case "REAL":
                BinaryPrimitives.WriteSingleLittleEndian(bytes, (float)number);
                return bytes;
            case "LREAL":
                BinaryPrimitives.WriteDoubleLittleEndian(bytes, number);
                return bytes;
        }
        long whole = checked((long)Math.Round(number));
        switch (bytes.Length)
        {
            case 1: bytes[0] = unchecked((byte)whole); break;
            case 2: BinaryPrimitives.WriteInt16LittleEndian(bytes, unchecked((short)whole)); break;
            case 4: BinaryPrimitives.WriteInt32LittleEndian(bytes, unchecked((int)whole)); break;
            case 8: BinaryPrimitives.WriteInt64LittleEndian(bytes, whole); break;
            default: throw new InvalidOperationException($"{path} is {symbol.TypeName}, which this bridge cannot write");
        }
        return bytes;
    }
}
