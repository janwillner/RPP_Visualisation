// ADS bridge for the visualisation gateway.
//
// Uses Beckhoff's official TwinCAT.Ads library, so it talks to the local AMS router like any TwinCAT
// application: no static route and no AMS TCP loopback needed. The gateway spawns this process and sends
// one JSON request per line on stdin; every request gets one JSON response line on stdout.
//
//   {"id":1,"op":"typeOf","path":"GVL_Visu.stManifest"}      -> {"id":1,"ok":true,"value":"ST_VisuManifest"} (null if missing)
//   {"id":2,"op":"read","path":"GVL_Visu.stManifest"}        -> {"id":2,"ok":true,"value":{...}}
//   {"id":3,"op":"sumRead","paths":["a","b"]}                -> {"id":3,"ok":true,"value":[...,...]}
//   {"id":4,"op":"sumWrite","writes":[{"path":"a.b[0].fX","value":1.5},{"path":"a.bStaged","value":true}]}
//                                                            -> {"id":4,"ok":true,"value":null} (in order; indices from 0)
//   errors                                                   -> {"id":n,"ok":false,"error":"...","notFound":true|false}
//
// Values: structs become objects keyed by member name, arrays become arrays, 64-bit integers become decimal
// strings (JS numbers cannot hold them exactly), enums become their integer value.

using System.Text.Json;
using System.Text.Json.Nodes;
using AdsBridge;

var options = BridgeOptions.Parse(args);
using var bridge = new Bridge(options);
using var stdin = new StreamReader(Console.OpenStandardInput());
var stdout = Console.Out;

string? line;
while ((line = await stdin.ReadLineAsync()) != null)
{
    if (line.Length == 0) continue;
    JsonObject response;
    long id = 0;
    try
    {
        var request = JsonNode.Parse(line)!.AsObject();
        id = request["id"]!.GetValue<long>();
        response = new JsonObject { ["id"] = id, ["ok"] = true, ["value"] = bridge.Handle(request) };
    }
    catch (SymbolNotFoundException e)
    {
        response = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = e.Message, ["notFound"] = true };
    }
    catch (Exception e)
    {
        bridge.Reset();
        response = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = e.Message, ["notFound"] = false };
    }
    await stdout.WriteLineAsync(response.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
    await stdout.FlushAsync();
}
