import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../src/components/ModelPicker";
import { Button, ConfirmDialog } from "../src/components/ui";

describe("accessible interactions", () => {
  it("focuses cancel, traps Tab and restores focus after Escape", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>打开确认</Button>
          <ConfirmDialog
            open={open}
            title="删除渠道？"
            description="测试"
            confirmLabel="删除"
            destructive
            onConfirm={remove}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "删除" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(remove).not.toHaveBeenCalled();
  });
  it("searches by provider and selects with the keyboard", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(
      <ModelPicker
        models={[
          { id: "a", name: "Alpha", provider: "mimo" },
          { id: "b", name: "Beta", provider: "workbuddy" },
        ]}
        value="a"
        onChange={change}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    await user.type(await screen.findByLabelText("搜索模型"), "workbuddy");
    expect(await screen.findByRole("option", { name: /Beta/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(change).toHaveBeenCalledWith("b");
  });
  it("keeps custom model IDs and supports multiple selections", async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState(["existing/model"]);
      return (
        <>
          <ModelPicker models={[]} multiple allowCustom value={value} onChange={setValue} />
          <output>{value.join(",")}</output>
        </>
      );
    }
    render(<Example />);
    await user.type(screen.getByRole("combobox"), "future/model");
    await user.click(await screen.findByRole("option", { name: /future\/model/ }));
    expect(screen.getByRole("status").textContent).toBe("existing/model,future/model");
    await user.click(screen.getByRole("button", { name: "移除 existing/model" }));
    expect(screen.getByRole("status").textContent).toBe("future/model");
  });
});
