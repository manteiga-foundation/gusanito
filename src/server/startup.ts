import type { NetworkInterfaceInfo } from "node:os";

/** What the server prints when it starts: the address on this computer and the ones phones on the same Wi-Fi can open. */
export function startupLines(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const lan = Object.values(interfaces)
    .flat()
    .filter((i): i is NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
  const lines = ["Gusanito is running.", `  On this computer:   http://localhost:${port}`];
  for (const url of lan) lines.push(`  On the same Wi-Fi:  ${url}`);
  lines.push("Share the Wi-Fi address with friends nearby, then create a match. Ctrl+C stops the server.");
  return lines;
}
