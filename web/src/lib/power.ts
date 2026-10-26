import type { Status } from "@/api";
import type { Tone } from "@/components/StatusDot";

/** Boot-time negotiation is an allowance, not a live current measurement. */
export function powerConnection(power: Status["power"]) {
  const contract = power?.bootContract || power?.firmwarePD?.contract;
  if (contract) return {
    value: `${contract.voltageV} V / ${contract.currentA} A`,
    detail: `${power?.bootContract ? "Linux 初始化" : "启动固件协商"} · 供电额度 ${+(contract.voltageV * contract.currentA).toFixed(2)} W${power?.vbusPresent === false ? " · 当前未检测到 USB-C 电压" : ""}`,
    tone: (power?.vbusPresent === false ? "warning" : "good") as Tone,
  };
  if (power?.vbusPresent === true) return {
    value: "已检测到电压", detail: "USB-C 有电压 · 本次协商额度未知", tone: "good" as Tone,
  };
  return {
    value: power?.vbusPresent === false ? "未检测到电压" : "状态未知",
    detail: "USB-C 供电检测 · 不判断 VIN 供电", tone: "idle" as Tone,
  };
}
