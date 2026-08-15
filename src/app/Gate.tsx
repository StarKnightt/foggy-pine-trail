'use client';

/* The front door.
 *
 * Two jobs, both of which have to happen before a single triangle is drawn.
 *
 * The scene is driven with pointer lock and WASD, neither of which a phone
 * has, and it budgets a mid-range desktop GPU. Rather than let a phone spend
 * forty seconds baking textures for a walk it cannot take, the gate checks for
 * a fine pointer and offers an override for the cases the media query gets
 * wrong — including the capture harness, which runs at viewports narrower than
 * the width test allows.
 *
 * And the bake is long. Every texture in this project is generated on first
 * frame, so there is a stretch of blocked main thread between the click and
 * the first picture. A black page during that stretch reads as a broken build,
 * so the veil stays up until the scene reports itself ready.
 */
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const Forest = dynamic(() => import('@/scene/Forest'), { ssr: false });

function drivable(): boolean {
  if (typeof window === 'undefined') return false;
  const fine = window.matchMedia?.('(pointer: fine)')?.matches ?? false;
  const lock = 'requestPointerLock' in Element.prototype;
  return fine && lock && window.innerWidth >= 700;
}

export function Gate() {
  const [state, setState] = useState<'checking' | 'blocked' | 'loading' | 'up'>('checking');

  useEffect(() => {
    setState(drivable() ? 'loading' : 'blocked');
  }, []);

  const ready = useCallback(() => setState('up'), []);
  const force = useCallback(() => setState('loading'), []);

  if (state === 'checking') return <div className="fixed inset-0 bg-black" />;

  if (state === 'blocked') {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#0b0e0d] px-6">
        <div className="max-w-sm text-center">
          <p className="text-[11px] font-medium tracking-[0.22em] text-white/40 uppercase">
            Foggy Pine Trail
          </p>
          <p className="mt-5 text-sm leading-relaxed text-white/55">
            This walk is driven with a mouse and a keyboard, and it asks a fair
            amount of the GPU. It wants a desktop.
          </p>
          <button
            type="button"
            onClick={force}
            className="mt-7 rounded-full border border-white/15 px-5 py-2 text-xs tracking-[0.14em] text-white/60 uppercase transition hover:border-white/35 hover:text-white/90"
          >
            Load it anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Forest onReady={ready} />
      {state === 'loading' && <Veil />}
    </>
  );
}

function Veil() {
  return (
    <div className="pointer-events-none fixed inset-0 grid place-items-center bg-[#0b0e0d]">
      <div className="w-56 text-center">
        <p className="text-[11px] font-medium tracking-[0.22em] text-white/40 uppercase">
          Foggy Pine Trail
        </p>
        <div className="mt-5 h-px w-full overflow-hidden bg-white/10">
          <div className="fp-sweep h-px w-1/3 bg-white/45" />
        </div>
        <p className="mt-4 text-[10px] tracking-[0.14em] text-white/25 uppercase">
          Generating bark, needles, fog
        </p>
      </div>
    </div>
  );
}
