import qrcode from "qrcode-generator";

// UTF-8 keeps non-ASCII hotspot names scannable.
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

// Escapes per the ZXing WIFI: URI convention that iOS and Android cameras parse.
export function wifiQRText(ssid: string, password: string) {
  const escape = (value: string) => value.replace(/[\\;,:"]/g, (c) => `\\${c}`);
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}

export function QRCode({ text, label }: { text: string; label: string }) {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
  }
  const size = count + 8;
  return (
    <svg className="mx-auto block size-56 max-w-full rounded-md bg-white" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
