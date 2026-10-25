import { Ellipsis } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type FileAction = { label: string; name: string; disabled?: boolean; destructive?: boolean; working?: boolean } & (
  { href: string; download: string; onSelect?: never } | { onSelect: () => void; href?: never; download?: never }
);

/** Desktop actions overlay metadata without changing tracks; touch uses a menu. */
export function FileActions({ name, actions, expanded }: { name: string; actions: FileAction[]; expanded: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  if (!actions.length) return null;
  return <>
    <span className={`absolute top-1.5 right-0 hidden items-center gap-2 rounded-md bg-card pl-2 group-hover/file:flex group-focus-within/file:flex max-md:hidden! pointer-coarse:hidden! ${expanded ? "md:flex" : ""}`}>
      {actions.map((action) => action.href ?
        <Button key={action.name} asChild variant="outline"><a href={action.href} download={action.download} aria-label={action.name}>{action.label}</a></Button> :
        <Button key={action.name} variant="outline" disabled={action.disabled} aria-label={action.name} aria-busy={action.working || undefined} onClick={action.onSelect}>{action.working && <Spinner />}{action.label}</Button>)}
    </span>
    <span className="absolute top-1.5 right-0 md:hidden pointer-coarse:block">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button ref={trigger} variant="ghost" size="icon" aria-label={`打开 ${name} 操作菜单`}><Ellipsis aria-hidden="true" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
          if (!pending.current) return;
          // A confirmation must remember the persistent trigger, not a removed menu item.
          event.preventDefault();
          trigger.current?.focus();
          const select = pending.current;
          pending.current = undefined;
          select();
        }}>
          {actions.map((action) => <DropdownMenuItem key={action.name} disabled={action.disabled} variant={action.destructive ? "destructive" : "default"}
            asChild={!!action.href} onSelect={() => { pending.current = action.onSelect; }}>
            {action.href ? <a href={action.href} download={action.download} aria-label={action.name}>{action.label}</a> : action.label}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </>;
}
