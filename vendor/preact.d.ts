// Minimal types for the vendored Preact + htm bundle (vendor/preact.js). Hand-written.
export type VNode = any;
export type ComponentChildren = any;
export type FunctionComponent<P = {}> = (props: P & { children?: ComponentChildren }) => VNode | null;
export interface Ref<T> { current: T }
export interface Context<T> { Provider: any; Consumer: any; displayName?: string; _default?: T }

export function h(type: any, props?: Record<string, any> | null, ...children: any[]): VNode;
export function render(vnode: VNode, parent: Element | DocumentFragment): void;
export const Fragment: any;
export function createContext<T>(defaultValue: T): Context<T>;
export function cloneElement(vnode: VNode, props?: Record<string, any>, ...children: any[]): VNode;
export function toChildArray(children: ComponentChildren): VNode[];
export function createRef<T = any>(): Ref<T>;
export class Component<P = {}, S = {}> {
  constructor(props?: P, context?: any);
  props: P;
  state: S;
  setState(state: Partial<S> | ((prev: S, props: P) => Partial<S>), cb?: () => void): void;
  forceUpdate(cb?: () => void): void;
  render(props?: P, state?: S, context?: any): VNode;
}

export function useState<S>(initial: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void];
export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S, init?: (arg: any) => S): [S, (action: A) => void];
export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
export function useRef<T>(initial: T): Ref<T>;
export function useRef<T = undefined>(): Ref<T | undefined>;
export function useMemo<T>(factory: () => T, deps: readonly any[]): T;
export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly any[]): T;
export function useContext<T>(context: Context<T>): T;
export function useId(): string;
export function useErrorBoundary(cb?: (error: any) => void): [any, () => void];

/** htm tagged template bound to h: html`<div class=${cls}>${children}</div>` */
export function html(strings: TemplateStringsArray, ...values: any[]): any;
