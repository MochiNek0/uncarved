// ink 和 react 只经这里导入。构建时 scripts/build-plugins.mjs 把编译出的 vendor.js 连同依赖打成一个文件：
// 逐个解析 ink 和它拉进来的整个 es-toolkit/compat 要约 470ms，打包后约 120ms（docs/review.md #28）。
// 两者必须打在同一个文件里，否则 ink 和界面各用一份 react，hooks 会失效。
// 只用到类型的从 "ink"/"react" 直接 import type，不经这里。

export { Box, render, Text, useBoxMetrics, useCursor, useInput, usePaste, useWindowSize } from "ink";
export {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
