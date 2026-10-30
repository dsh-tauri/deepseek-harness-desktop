export type SelectorHook<T> = <S>(sel: (state: T) => S) => S
