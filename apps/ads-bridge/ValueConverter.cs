using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;
using TwinCAT.TypeSystem;

namespace AdsBridge;

/// <summary>Converts raw PLC memory to JSON using the symbol's data type information.</summary>
internal static class ValueConverter
{
    public static JsonNode? Convert(ResolvedSymbol symbol, byte[] data)
    {
        if (symbol.DataType != null) return Convert(symbol.DataType, data);
        // No type information (e.g. type not in the loader): fall back on the type name.
        return ConvertPrimitive(symbol.TypeName, data) ?? throw new InvalidOperationException($"No type information for {symbol.TypeName}");
    }

    private static JsonNode? Convert(IDataType type, ReadOnlySpan<byte> data)
    {
        switch (type.Category)
        {
            case DataTypeCategory.Struct:
            {
                var members = ((IStructType)type).AllMembers;
                var obj = new JsonObject();
                foreach (var member in members)
                {
                    if (member.DataType == null || member.ByteOffset + member.ByteSize > data.Length) continue;
                    var slice = data.Slice(member.ByteOffset, member.ByteSize);
                    obj[member.InstanceName] = member.DataType.Category == DataTypeCategory.Array
                        ? ConvertArray((IArrayType)member.DataType, slice, CountOf(members, member.InstanceName, data))
                        : Convert(member.DataType, slice);
                }
                return obj;
            }
            case DataTypeCategory.Array:
                return ConvertArray((IArrayType)type, data, int.MaxValue);
            case DataTypeCategory.Alias:
            {
                var baseType = ((IAliasType)type).BaseType;
                return baseType != null ? Convert(baseType, data) : ConvertPrimitive(type.Name, data);
            }
            case DataTypeCategory.Enum:
                return ConvertInteger(data, signed: false);
            case DataTypeCategory.String:
            {
                int end = data.IndexOf((byte)0);
                return JsonValue.Create(Encoding.Latin1.GetString(end >= 0 ? data[..end] : data));
            }
            default:
                return ConvertPrimitive(type.Name, data) ?? ConvertInteger(data, signed: false);
        }
    }

    /// <summary>The first <paramref name="limit"/> entries of an array (all of them if it is larger than the array).</summary>
    private static JsonArray ConvertArray(IArrayType arrayType, ReadOnlySpan<byte> data, int limit)
    {
        var elementType = arrayType.ElementType ?? throw new InvalidOperationException($"No element type for {arrayType.Name}");
        int count = Math.Min(arrayType.Dimensions.ElementCount, limit);
        int size = elementType.ByteSize;
        var array = new JsonArray();
        for (int i = 0; i < count && (i + 1) * size <= data.Length; i++) array.Add(Convert(elementType, data.Slice(i * size, size)));
        return array;
    }

    /// <summary>
    /// The value of the count member of array <paramref name="arrayName"/> (<c>aProducts</c> → <c>nProductCount</c>,
    /// <c>aBodies</c> → <c>nBodyCount</c>, as the gateway's plc-mapping), or int.MaxValue when the structure has none.
    /// The gateway cuts such arrays to their count anyway; converting only the used entries keeps a large array size
    /// (e.g. VISU_un_MAX_PRODUCTS) from costing time on every read.
    /// </summary>
    private static int CountOf(IEnumerable<IMember> members, string arrayName, ReadOnlySpan<byte> data)
    {
        if (CountMemberName(arrayName) is not { } countName) return int.MaxValue;
        var countMember = members.FirstOrDefault(m => string.Equals(m.InstanceName, countName, StringComparison.OrdinalIgnoreCase));
        if (countMember?.DataType == null || countMember.ByteOffset + countMember.ByteSize > data.Length) return int.MaxValue;
        var raw = data.Slice(countMember.ByteOffset, countMember.ByteSize);
        bool signed = countMember.DataType.Name.ToUpperInvariant() is "SINT" or "INT" or "DINT" or "LINT";
        long value = (raw.Length, signed) switch
        {
            (1, true) => (sbyte)raw[0],
            (1, false) => raw[0],
            (2, true) => BinaryPrimitives.ReadInt16LittleEndian(raw),
            (2, false) => BinaryPrimitives.ReadUInt16LittleEndian(raw),
            (4, true) => BinaryPrimitives.ReadInt32LittleEndian(raw),
            (4, false) => BinaryPrimitives.ReadUInt32LittleEndian(raw),
            _ => long.MaxValue, // not an integer count: keep the whole array
        };
        return (int)Math.Clamp(value, 0, int.MaxValue);
    }

    /// <summary>
    /// The count member of an array as the contract names it (<c>aProducts</c> → <c>nProductCount</c>), or null for a
    /// member that is not named like an array.
    /// </summary>
    public static string? CountMemberName(string arrayName) =>
        arrayName.Length < 2 || arrayName[0] != 'a' || !char.IsUpper(arrayName[1]) ? null : $"n{Singular(arrayName[1..])}Count";

    /// <summary><c>Products</c> → <c>Product</c>, <c>Bodies</c> → <c>Body</c>: the count member is named after one entry.</summary>
    private static string Singular(string name) =>
        name.EndsWith("ies") ? $"{name[..^3]}y" : name.EndsWith('s') ? name[..^1] : name;

    private static JsonNode? ConvertPrimitive(string typeName, ReadOnlySpan<byte> data)
    {
        string name = typeName.ToUpperInvariant();
        if (name.StartsWith("STRING"))
        {
            int end = data.IndexOf((byte)0);
            return JsonValue.Create(Encoding.Latin1.GetString(end >= 0 ? data[..end] : data));
        }
        return name switch
        {
            "BOOL" or "BIT" => JsonValue.Create(data[0] != 0),
            "REAL" => JsonValue.Create(BinaryPrimitives.ReadSingleLittleEndian(data)),
            "LREAL" => JsonValue.Create(BinaryPrimitives.ReadDoubleLittleEndian(data)),
            "SINT" or "INT" or "DINT" or "LINT" => ConvertInteger(data, signed: true),
            "BYTE" or "USINT" or "WORD" or "UINT" or "DWORD" or "UDINT" or "LWORD" or "ULINT"
                or "TIME" or "TOD" or "TIME_OF_DAY" or "DATE" or "DT" or "DATE_AND_TIME" or "LTIME" => ConvertInteger(data, signed: false),
            _ => null,
        };
    }

    /// <summary>Integers up to 32 bit as numbers; 64-bit values as decimal strings.</summary>
    private static JsonNode ConvertInteger(ReadOnlySpan<byte> data, bool signed) => (data.Length, signed) switch
    {
        (1, true) => JsonValue.Create((sbyte)data[0]),
        (1, false) => JsonValue.Create(data[0]),
        (2, true) => JsonValue.Create(BinaryPrimitives.ReadInt16LittleEndian(data)),
        (2, false) => JsonValue.Create(BinaryPrimitives.ReadUInt16LittleEndian(data)),
        (4, true) => JsonValue.Create(BinaryPrimitives.ReadInt32LittleEndian(data)),
        (4, false) => JsonValue.Create(BinaryPrimitives.ReadUInt32LittleEndian(data)),
        (8, true) => JsonValue.Create(BinaryPrimitives.ReadInt64LittleEndian(data).ToString()),
        (8, false) => JsonValue.Create(BinaryPrimitives.ReadUInt64LittleEndian(data).ToString()),
        _ => JsonValue.Create(System.Convert.ToHexString(data)),
    };
}
