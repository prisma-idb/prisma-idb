import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Omits the children-rendering prop when the source type provides one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
/** Adds a bindable reference to a component’s rendered HTML element. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
