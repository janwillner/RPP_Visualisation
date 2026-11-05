using System.Buffers.Binary;
using TwinCAT.TypeSystem;

namespace AdsBridge;

/// <summary>
/// A large array directly in a symbol's structure that has a count member (<c>aProducts</c> and <c>nProductCount</c>):
/// only its counted entries need reading. Offsets are in bytes from the start of the symbol.
/// </summary>
internal sealed record CountedArray(int Offset, int ElementSize, int Capacity, int CountOffset, int CountSize, bool CountSigned)
{
    /// <summary>The count member's value in the symbol's bytes, limited to the array's capacity.</summary>
    public int CountIn(ReadOnlySpan<byte> symbol)
    {
        var raw = symbol.Slice(CountOffset, CountSize);
        long value = (CountSize, CountSigned) switch
        {
            (1, true) => (sbyte)raw[0],
            (1, false) => raw[0],
            (2, true) => BinaryPrimitives.ReadInt16LittleEndian(raw),
            (2, false) => BinaryPrimitives.ReadUInt16LittleEndian(raw),
            (4, true) => BinaryPrimitives.ReadInt32LittleEndian(raw),
            _ => BinaryPrimitives.ReadUInt32LittleEndian(raw),
        };
        return (int)Math.Clamp(value, 0, Capacity);
    }
}

/// <summary>A byte range of a symbol to read.</summary>
internal readonly record struct Segment(int Offset, int Length);

/// <summary>
/// Which bytes of a symbol to read. A product register is an array of thousands of entries of which the PLC uses only
/// the first <c>nProductCount</c>; reading the whole array costs far more than converting the used part. So a counted
/// array is read only up to the count of the previous read plus a reserve for entries added since, in the same
/// sum-read as the count itself. A count beyond that is read in a second sum-read.
/// </summary>
internal static class ReadPlan
{
    /// <summary>Arrays smaller than this are read whole: splitting them would save less than it costs.</summary>
    public const int MinSplitBytes = 4096;

    /// <summary>Entries read beyond the previous count, for entries added since: a quarter more plus 32.</summary>
    public static int WithReserve(int previousCount, int capacity) => Math.Min(capacity, previousCount + previousCount / 4 + 32);

    /// <summary>Index groups whose symbols are plain memory, so a part of a symbol is read at its offset.</summary>
    private static readonly HashSet<uint> OffsetAddressable = [0x4020, 0x4040, 0xF020, 0xF021, 0xF030, 0xF031];

    /// <summary>The counted arrays of a symbol worth reading in part; none if its memory cannot be read in parts.</summary>
    public static IReadOnlyList<CountedArray> CountedArrays(uint indexGroup, IDataType? type)
    {
        while (type is IAliasType alias && alias.BaseType != null) type = alias.BaseType;
        if (!OffsetAddressable.Contains(indexGroup) || type is not IStructType structure) return [];
        var members = structure.AllMembers;
        var result = new List<CountedArray>();
        foreach (var member in members)
        {
            if (member.DataType is not IArrayType array || array.ElementType == null || member.ByteSize < MinSplitBytes) continue;
            var countName = ValueConverter.CountMemberName(member.InstanceName);
            var count = countName == null
                ? null
                : members.FirstOrDefault(m => string.Equals(m.InstanceName, countName, StringComparison.OrdinalIgnoreCase));
            if (count?.DataType == null || count.ByteSize is not (1 or 2 or 4)) continue;
            bool signed = count.DataType.Name.ToUpperInvariant() is "SINT" or "INT" or "DINT";
            result.Add(new CountedArray(member.ByteOffset, array.ElementType.ByteSize, array.Dimensions.ElementCount,
                count.ByteOffset, count.ByteSize, signed));
        }
        return result.OrderBy(a => a.Offset).ToList();
    }

    /// <summary>
    /// The ranges to read of a symbol of <paramref name="size"/> bytes: all of it except, per counted array, the
    /// entries beyond <paramref name="entries"/> (how many to read of each array, in the order of the arrays).
    /// </summary>
    public static List<Segment> Segments(int size, IReadOnlyList<CountedArray> arrays, IReadOnlyList<int> entries)
    {
        var segments = new List<Segment>();
        int from = 0;
        for (int i = 0; i < arrays.Count; i++)
        {
            var a = arrays[i];
            int end = a.Offset + entries[i] * a.ElementSize;
            if (end > from) segments.Add(new Segment(from, end - from));
            from = a.Offset + a.Capacity * a.ElementSize;
        }
        if (size > from) segments.Add(new Segment(from, size - from));
        return segments;
    }
}
