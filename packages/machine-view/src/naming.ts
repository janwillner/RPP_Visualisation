import type { ConfigMessage } from "@rpp/protocol";

/** Abbreviations a field name holds, written as the domain writes them. */
const ABBREVIATIONS: Record<string, string> = { tcp: "TCP", ccs: "CCS" };

/** `gripperActive` → "Gripper active", `x` → "X", `tcpLimitArea` → "TCP limit area". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One entry of a list, by the list's name: "movers" → "mover", "modules" → "module". */
export function singular(list: string): string {
  if (list.endsWith("ies")) return `${list.slice(0, -3)}y`;
  return list.endsWith("s") ? list.slice(0, -1) : list;
}

/** A component's name from its source's config; `fallback` (default `#id`) when the config does not list it. */
export function componentName(config: ConfigMessage | undefined, id: number, fallback = `#${id}`): string {
  return config?.components.find((c) => c.id === id)?.name ?? fallback;
}
