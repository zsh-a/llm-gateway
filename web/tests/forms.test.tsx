import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChannelForm } from "../src/features/management/ChannelForm";
import { KeyForm } from "../src/features/management/KeyForm";
import {
  channelDraftFrom,
  channelInput,
  channelSchema,
  initialChannel,
  initialKey,
  keyInput,
  keySchema,
  suggestedChannelId,
} from "../src/features/management/types";
import type { ChannelConfig } from "../src/types";

const channel: ChannelConfig = {
  id: "mimo-default",
  name: "Existing",
  providerId: "mimo",
  authRef: "mimo",
  enabled: false,
  upstreamUrl: "https://old.example.com",
  modelMappings: { public: "upstream" },
};

describe("resource form contracts", () => {
  it("allocates a new ID instead of replacing an existing default channel", () => {
    expect(suggestedChannelId("mimo", [channel])).toBe("mimo-2");
    expect(suggestedChannelId("mimo", [channel, { ...channel, id: "mimo-2" }])).toBe("mimo-3");
  });
  it("preserves disabled state while clearing optional routing settings", () => {
    const draft = {
      ...channelDraftFrom(channel),
      upstreamUrl: "",
      authRef: "",
      priority: "",
      weight: "",
      modelMappings: [],
    };
    expect(channelInput(channelSchema.parse(draft), channel)).toMatchObject({
      enabled: false,
      upstreamUrl: "",
      authRef: "mimo",
      priority: 100,
      weight: 1,
      modelMappings: {},
    });
  });
  it("reports mapping errors at the correct fields and rejects unsafe integer limits", () => {
    const result = channelSchema.safeParse({
      ...initialChannel,
      id: "new",
      providerId: "mimo",
      modelMappings: [
        { publicModel: "a", upstreamModel: "b" },
        { publicModel: " a ", upstreamModel: "" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["modelMappings.1.publicModel", "modelMappings.1.upstreamModel"]),
      );
    for (const rpmLimit of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(keySchema.safeParse({ ...initialKey, name: "test", rpmLimit }).success).toBe(false);
    }
  });
  it("sends null to clear existing limits and preserves custom model IDs", () => {
    expect(
      keyInput({ ...initialKey, name: " test ", allowedModels: ["custom/model"] }, true),
    ).toEqual({
      name: "test",
      allowedModels: ["custom/model"],
      rpmLimit: null,
      tpmLimit: null,
      quotaTokens: null,
    });
  });
  it("submits a new channel without overwriting an existing one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelForm
        channels={[channel]}
        providers={["mimo"]}
        models={[]}
        disabled={false}
        onDirtyChange={vi.fn()}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "mimo");
    await user.click(screen.getByRole("button", { name: "创建渠道" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ id: "mimo-2", providerId: "mimo" }));
  });
  it("shows field validation and updates the policy summary before saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <KeyForm
        models={[]}
        disabled={false}
        onDirtyChange={vi.fn()}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole("button", { name: "创建 Key" }));
    expect(await screen.findByText("请填写 Key 名称")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Key 名称"), "Test");
    await user.type(screen.getByLabelText("每分钟请求数（RPM）"), "60");
    expect(screen.getByText("允许全部模型 · RPM 60")).toBeTruthy();
  });
});
