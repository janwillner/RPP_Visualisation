import { describe, expect, it } from "vitest";
import { bridgeLaunch } from "../src/ads-bridge-symbol-access";

const target = { targetAmsNetId: "127.0.0.1.1.1", targetAdsPort: 852 };

describe("bridgeLaunch", () => {
  it("starts the self-contained bridge exe directly", () => {
    expect(bridgeLaunch({ bridgePath: "C:\\Program Files\\RPP_Visualisation\\AdsBridge.exe", ...target })).toEqual({
      command: "C:\\Program Files\\RPP_Visualisation\\AdsBridge.exe",
      args: ["--ams-net-id", "127.0.0.1.1.1", "--ads-port", "852"],
    });
  });

  it("runs the development dll through dotnet", () => {
    expect(bridgeLaunch({ bridgePath: "apps/ads-bridge/bin/Release/net9.0/AdsBridge.dll", ...target })).toEqual({
      command: "dotnet",
      args: ["apps/ads-bridge/bin/Release/net9.0/AdsBridge.dll", "--ams-net-id", "127.0.0.1.1.1", "--ads-port", "852"],
    });
  });
});
