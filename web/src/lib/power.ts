import type { Status } from "@/api";
import type { Tone } from "@/components/StatusDot";
import { t } from "@/i18n";
import { number } from "@/i18n/format";

/** The boot-time power budget does not measure live current. */
export function powerConnection(power: Status["power"]) {
  const contract = power?.bootContract || power?.firmwarePD?.contract;
  if (contract) return {
    value: `${number(contract.voltageV)} V / ${number(contract.currentA)} A`,
    detail: t(power?.vbusPresent === false ? "power.budgetNoVoltage" : "power.budget", {
      source: t(power?.bootContract ? "power.linux" : "power.firmware"),
      watts: number(contract.voltageV * contract.currentA, { maximumFractionDigits: 2 }),
    }),
    tone: (power?.vbusPresent === false ? "warning" : "good") as Tone,
  };
  if (power?.vbusPresent === true) return {
    value: t("power.voltagePresent"), detail: t("power.voltageUnknown"), tone: "good" as Tone,
  };
  return {
    value: power?.vbusPresent === false ? t("power.noVoltage") : t("common.unknown"),
    detail: t("power.detection"), tone: "idle" as Tone,
  };
}
