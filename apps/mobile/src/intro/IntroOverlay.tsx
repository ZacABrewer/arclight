import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { createIntroStage } from '../../../../design/brand/intro/src/stage.js';
import { DURATION, LOGO_TIME } from '../../../../design/brand/intro/src/timeline.js';
import { isNative } from '../platform/capacitor.js';
import { STATIC_HOLD_MS, introScale, type IntroMode } from './policy.js';
import type { Sting } from './sting.js';

/**
 * The startup intro, drawn live in the app's own DOM (crisp at any size, no video): the 1920x1080
 * stage scaled to the screen on black. Tap anywhere, Escape or the Android back gesture skips it.
 * `onDone` fires once, when it ends or is skipped.
 */
export function IntroOverlay({ mode, sting, onDone }: { mode: Exclude<IntroMode, 'skip'>; sting: Sting | null; onDone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const skip = useRef<() => void>(() => undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = createIntroStage(document, { clip: false });
    Object.assign(stage.el.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      marginLeft: '-960px',
      marginTop: '-540px',
    });
    el.appendChild(stage.el);
    const fit = () => {
      stage.el.style.transform = `scale(${introScale(window.innerWidth, window.innerHeight)})`;
    };
    fit();
    window.addEventListener('resize', fit);

    let finished = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      done.current();
    };
    skip.current = finish;

    if (mode === 'static') {
      stage.render(LOGO_TIME);
      timer = setTimeout(finish, STATIC_HOLD_MS);
    } else {
      stage.render(0);
      const t0 = performance.now();
      sting?.start(0);
      const tick = (now: number) => {
        const t = (now - t0) / 1000;
        stage.render(t);
        if (t >= DURATION) finish();
        else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
    };
    window.addEventListener('keydown', onKey);
    // A backButton listener replaces Android's default back handling only while it is registered.
    const back = isNative() ? CapApp.addListener('backButton', finish).catch(() => null) : Promise.resolve(null);

    return () => {
      finished = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      sting?.stop();
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', onKey);
      void back.then((h) => h?.remove());
      stage.el.remove();
    };
  }, [mode, sting]);

  return <div ref={host} className="intro" role="button" tabIndex={0} aria-label="Arclight intro. Tap to skip." onPointerDown={() => skip.current()} />;
}
