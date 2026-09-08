import "react-native";

declare module "react-native" {
  interface ViewProps {
    className?: string;
    [attribute: `data-${string}`]: unknown;
  }
}

declare global {
  function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout;
  function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout;
}
