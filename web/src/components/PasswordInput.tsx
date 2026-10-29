import { useRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useT } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="relative flex min-w-0 items-center [&_input]:pr-10">
      <Input {...props} ref={input} type={visible ? "text" : "password"} spellCheck={false} autoCapitalize="off" />
      <Button type="button" variant="ghost" size="icon" className="absolute right-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
        aria-label={visible ? t("login.hidePassword") : t("login.showPassword")} aria-pressed={visible}
        onClick={() => {
          setVisible(!visible);
          input.current?.focus();
        }}
      >{visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
    </span>
  );
}
