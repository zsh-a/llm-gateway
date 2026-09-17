declare module "perry/ui" {
  export type Widget = number;

  export type WindowHandle = {
    setBody(body: Widget): void;
    show(): void;
    hide(): void;
    setSize(width: number, height: number): void;
    close(): void;
    onFocusLost(callback: () => void): void;
  };

  export function App(config: {
    title: string;
    width: number;
    height: number;
    body: Widget;
    activationPolicy?: "regular" | "accessory" | "background";
  }): void;

  export function Text(content: string, id?: string): Widget;

  export function Window(
    title: string,
    width: number,
    height: number
  ): WindowHandle;

  export function menuCreate(): Widget;
  export function menuAddItem(
    menu: Widget,
    title: string,
    callback: () => void
  ): void;
  export function menuAddSeparator(menu: Widget): void;

  export function trayCreate(iconPath: string): Widget;
  export function traySetTooltip(tray: Widget, tooltip: string): void;
  export function trayAttachMenu(tray: Widget, menu: Widget): void;
  export function trayOnClick(tray: Widget, callback: () => void): void;
  export function trayDestroy(tray: Widget): void;

  export function onTerminate(callback: () => void): void;
  export function onActivate(callback: () => void): void;
}
