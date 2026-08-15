'use client';

/* Client-only. The canvas touches WebGL, pointer lock and `window` before
 * first paint, and there is nothing meaningful to server render for a
 * full-viewport 3D scene. `Gate` owns the dynamic import: it decides whether
 * the visitor has the keyboard and pointer this walk is driven with, and
 * covers the texture bake with something other than a black page. */
import { Gate } from './Gate';

export default function Page() {
  return <Gate />;
}
