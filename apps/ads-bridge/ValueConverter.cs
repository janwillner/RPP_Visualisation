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
                var obj = new JsonObject();
                foreach (var member in ((IStructType)type).AllMembers)
                {
                    if (member.DataType == null || member.ByteOffset + member.ByteSize > data.Length) continue;
                    obj[member.InstanceName] = Convert(member.DataType, data.Slice(member.ByteOffset, member.ByteSize));
                }
                return obj;
            }
            case DataTypeCategory.Array:
            {
                var arrayType = (IArrayType)type;
                var elementType = arrayType.ElementType ?? throw new InvalidOperationException($"No element type for {type.Name}");
                int count = arrayType.Dimensions.ElementCount;
                int size = elementType.ByteSize;
                var array = new JsonArray();
                for (int i = 0; i < count && (i + 1) * size <= data.Length; i++) array.Add(Convert(elementType, data.Slice(i * size, size)));
                return array;
            }
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
