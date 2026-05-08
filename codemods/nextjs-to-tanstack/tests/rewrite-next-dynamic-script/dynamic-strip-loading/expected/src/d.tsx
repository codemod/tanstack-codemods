// TODO: next/dynamic loading UI stripped (R4c): restore loading UX with `<Suspense fallback={…}>` — https://react.dev/reference/react/Suspense
import { lazy } from 'react';

const C = lazy(() => import("./mod"));

export default C;
