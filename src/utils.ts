export async function sleep(timeMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeMs);
  });
}

export function hex2str(hex: string): string {
  return Buffer.from(hex.substring(2), "hex").toString();
}

export function formatHexArr(arr: number[]): string {
  return "0x" + Buffer.from(arr).toString("hex");
}
