import { Search, X } from "lucide-react";
import { useRef } from "react";
import { Button, Input } from "./ui";

export function ModelSearch({
  value,
  onChange,
  descriptionId,
}: {
  value: string;
  onChange: (value: string) => void;
  descriptionId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        type="search"
        aria-label="搜索模型"
        aria-describedby={descriptionId}
        placeholder="搜索模型名称、ID 或 Provider"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
        className="pr-10 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 size-8"
          aria-label="清除模型搜索"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
