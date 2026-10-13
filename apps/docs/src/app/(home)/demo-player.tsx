"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Play, Pause, RotateCcw, RefreshCw } from "lucide-react";
import { DesktopSyncOverlay, MobileSyncOverlay, CentralServer } from "./sync-flow-overlay";
import { MOBILE_DELAY, SYNC_START_AT, SYNC_DONE_AT } from "./demo-timings";

const TRIM_END = 4; // stop playback this many seconds before the raw video ends

const CHAPTERS = [
  { start: 0, label: "Offline edits → Outbox" },
  { start: 5.75, label: "Resilient sync → Server" },
  { start: MOBILE_DELAY, label: "Pull changelog → Second device" },
] as const;

function getChapter(time: number) {
  for (let i = CHAPTERS.length - 1; i >= 0; i--) {
    if (time >= CHAPTERS[i].start) return CHAPTERS[i];
  }
  return CHAPTERS[0];
}

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-zinc-700/50 bg-zinc-900/80 px-4 py-2.5">
        <div className="flex gap-1.5">
          <div className="h-2 w-2 rounded-full bg-zinc-700" />
          <div className="h-2 w-2 rounded-full bg-zinc-700" />
          <div className="h-2 w-2 rounded-full bg-zinc-700" />
        </div>
        <div className="mx-auto flex items-center rounded-md bg-zinc-800 px-3 py-0.5">
          <span className="text-[11px] text-zinc-400">next-kanban.prisma-idb.dev</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-50 overflow-hidden rounded-4xl border-4 border-zinc-700 bg-zinc-950 shadow-2xl">
      <div className="mx-auto h-5 w-20 rounded-b-xl bg-zinc-800" />
      {children}
    </div>
  );
}

export function DemoPlayer() {
  const desktopRef = useRef<HTMLVideoElement>(null);
  const mobileRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [desktopDuration, setDesktopDuration] = useState(0);
  const [isLg, setIsLg] = useState(true); // default to lg to avoid flash
  const [mobileStarted, setMobileStarted] = useState(false);
  const syncing = currentTime >= SYNC_START_AT && currentTime < SYNC_DONE_AT;
  const hasAutoPlayed = useRef(false);
  const mobileAutoStartBlocked = useRef(false);
  const mobileStartToken = useRef(0);

  const startMobile = useCallback(async () => {
    const mobile = mobileRef.current;
    if (!mobile) return;
    mobileStartToken.current++;
    const myToken = mobileStartToken.current;
    try {
      await mobile.play();
      if (mobileStartToken.current !== myToken) return;
      setMobileStarted(true);
    } catch {
      if (mobileStartToken.current !== myToken) return;
      mobileAutoStartBlocked.current = true;
      setMobileStarted(false);
    }
  }, []);

  // Detect screen size
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsLg(e.matches);
    handler({ matches: mql.matches } as MediaQueryListEvent);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const tick = useCallback(() => {
    const desktop = desktopRef.current;
    if (desktop && desktop.duration > 0 && !Number.isNaN(desktop.duration)) {
      const effectiveDuration = desktop.duration - TRIM_END;
      const clampedTime = Math.min(desktop.currentTime, effectiveDuration);
      setProgress(clampedTime / effectiveDuration);
      setCurrentTime(clampedTime);
      setDesktopDuration(effectiveDuration);
      if (desktop.currentTime >= effectiveDuration) {
        desktop.pause();
        setPlaying(false);
        setEnded(true);
        setProgress(1);
      }
    }
  }, []);

  // Catch already-loaded metadata (fires before hydration with preload="auto")
  useEffect(() => {
    const desktop = desktopRef.current;
    if (desktop && desktop.duration > 0 && !Number.isNaN(desktop.duration)) {
      setDesktopDuration(desktop.duration - TRIM_END);
    }
  }, [isLg]);

  // Autoplay on desktop when scrolled into view
  useEffect(() => {
    const container = containerRef.current;
    const desktop = desktopRef.current;
    if (!container || !desktop) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAutoPlayed.current) {
          desktop
            .play()
            .then(() => {
              hasAutoPlayed.current = true;
              setPlaying(true);
            })
            .catch(() => {});
        }
      },
      { threshold: 0.4 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [isLg]);

  // Auto-pause when the player scrolls out of view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          const desktop = desktopRef.current;
          const mobile = mobileRef.current;
          if (desktop && !desktop.paused) {
            mobileStartToken.current++;
            desktop.pause();
            mobile?.pause();
            setPlaying(false);
          }
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // RAF loop — always running while playing
  useEffect(() => {
    if (!playing) return;
    let id: number;
    const loop = () => {
      tick();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, tick]);

  // Start mobile video when desktop reaches MOBILE_DELAY
  useEffect(() => {
    const desktop = desktopRef.current;
    const mobile = mobileRef.current;
    if (!desktop || !mobile) return;

    const onTimeUpdate = () => {
      if (
        desktop.currentTime >= MOBILE_DELAY &&
        mobile.paused &&
        !mobile.ended &&
        playing &&
        !mobileAutoStartBlocked.current
      ) {
        startMobile();
      }
    };

    desktop.addEventListener("timeupdate", onTimeUpdate);
    return () => desktop.removeEventListener("timeupdate", onTimeUpdate);
  }, [playing, startMobile, isLg]);

  // When desktop ends
  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop) return;

    const onEnded = () => {
      setPlaying(false);
      setEnded(true);
      setProgress(1);
    };

    desktop.addEventListener("ended", onEnded);
    return () => desktop.removeEventListener("ended", onEnded);
  }, [isLg]);

  const seek = (fraction: number) => {
    const desktop = desktopRef.current;
    const mobile = mobileRef.current;
    if (!desktop || !mobile || desktopDuration === 0) return;

    const time = Math.min(fraction * desktopDuration, desktopDuration);
    desktop.currentTime = time;
    setProgress(fraction);
    setCurrentTime(time);
    setEnded(false);

    if (time >= MOBILE_DELAY) {
      mobile.currentTime = time - MOBILE_DELAY;
      if (playing) startMobile();
    } else {
      mobileStartToken.current++;
      mobile.currentTime = 0;
      mobile.pause();
      mobileAutoStartBlocked.current = false;
      setMobileStarted(false);
    }
  };

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = progressBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(fraction);
  };

  const playPause = () => {
    const desktop = desktopRef.current;
    const mobile = mobileRef.current;
    if (!desktop || !mobile) return;

    if (playing) {
      mobileStartToken.current++;
      desktop.pause();
      mobile.pause();
      setPlaying(false);
    } else {
      if (ended) {
        restart();
        return;
      }
      desktop
        .play()
        .then(() => {
          if (desktop.currentTime >= MOBILE_DELAY) {
            mobileAutoStartBlocked.current = false;
            startMobile();
          }
          setPlaying(true);
        })
        .catch(() => setPlaying(false));
    }
  };

  const restart = () => {
    const desktop = desktopRef.current;
    const mobile = mobileRef.current;
    if (!desktop || !mobile) return;

    mobileStartToken.current++;
    desktop.currentTime = 0;
    mobile.currentTime = 0;
    mobile.pause();
    mobileAutoStartBlocked.current = false;
    setMobileStarted(false);
    setProgress(0);
    setCurrentTime(0);
    setEnded(false);
    desktop
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  };

  const chapter = getChapter(currentTime);

  // On small screens, show desktop first, then switch to phone at MOBILE_DELAY
  // Only switch when mobileStarted is true so the desktop fallback stays visible if handoff failed
  const showPhoneOnMobile = !isLg && currentTime >= MOBILE_DELAY && mobileStarted;

  return (
    <div ref={containerRef}>
      {isLg ? (
        /* Large screens: desktop + sync animation + phone side by side */
        <div className="flex items-end justify-center gap-6">
          <div className="max-w-2xl flex-1">
            <BrowserFrame>
              <div className="bg-zinc-950">
                <video
                  ref={desktopRef}
                  src="/demo-desktop.mp4"
                  className="h-full w-full"
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => setDesktopDuration(e.currentTarget.duration - TRIM_END)}
                />
              </div>
            </BrowserFrame>
            <DesktopSyncOverlay currentTime={currentTime} />
          </div>

          <CentralServer currentTime={currentTime} />

          <div className="shrink-0">
            <PhoneFrame>
              <video
                ref={mobileRef}
                src="/demo-mobile.mp4"
                className="w-full"
                style={{ aspectRatio: "520/1080" }}
                muted
                playsInline
                preload="auto"
              />
            </PhoneFrame>
            <MobileSyncOverlay currentTime={currentTime} />
          </div>
        </div>
      ) : (
        /* Small screens: cross-fade desktop → phone at MOBILE_DELAY.
           The active layer stays in normal flow (drives container height);
           the inactive layer is position:absolute so it never reserves space. */
        <div className="relative">
          {/* Desktop layer — in flow while active, absolutely overlaid while fading out */}
          <div
            className={`transition-opacity duration-500 ${
              showPhoneOnMobile ? "pointer-events-none absolute inset-x-0 top-0 opacity-0" : "opacity-100"
            }`}
            aria-hidden={showPhoneOnMobile || undefined}
            {...(showPhoneOnMobile ? { inert: true } : {})}
          >
            <BrowserFrame>
              <div className="bg-zinc-950">
                <video
                  ref={desktopRef}
                  src="/demo-desktop.mp4"
                  className="h-full w-full"
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => setDesktopDuration(e.currentTarget.duration - TRIM_END)}
                />
              </div>
            </BrowserFrame>
            <DesktopSyncOverlay currentTime={currentTime} />
            {/* Spinner — always rendered to avoid layout shift; fades in/out */}
            <div
              className={`flex justify-center py-4 transition-opacity duration-300 ${
                syncing ? "opacity-100" : "opacity-0"
              }`}
            >
              <RefreshCw className="h-5 w-5 animate-spin text-[hsl(32,100%,50%)]" />
            </div>
          </div>

          {/* Phone layer — in flow while active, absolutely overlaid while fading in */}
          <div
            className={`flex flex-col items-center transition-opacity duration-500 ${
              showPhoneOnMobile ? "opacity-100" : "pointer-events-none absolute inset-x-0 top-0 opacity-0"
            }`}
            aria-hidden={!showPhoneOnMobile || undefined}
            {...(!showPhoneOnMobile ? { inert: true } : {})}
          >
            <PhoneFrame>
              <video
                ref={mobileRef}
                src="/demo-mobile.mp4"
                className="w-full"
                style={{ aspectRatio: "520/1080" }}
                muted
                playsInline
                preload="auto"
              />
            </PhoneFrame>
            <MobileSyncOverlay currentTime={currentTime} />
          </div>
        </div>
      )}

      {/* Chapter + Controls */}
      <div className="mx-auto mt-6 max-w-md">
        <div className="mb-2 h-5 text-center">
          <p
            key={chapter.label}
            className="animate-slide-in text-sm font-medium tracking-wide text-zinc-500 dark:text-zinc-400"
            aria-live="polite"
            aria-atomic="true"
          >
            {chapter.label}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={playPause}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 transition-colors hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            aria-label={playing ? "Pause" : ended ? "Replay" : "Play"}
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" />
            ) : ended ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5 translate-x-px" />
            )}
          </button>

          {/* Progress bar */}
          <div
            ref={progressBarRef}
            role="slider"
            tabIndex={0}
            aria-label="Demo progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="relative flex-1 cursor-pointer py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(32,100%,50%)] focus-visible:ring-offset-2"
            onClick={handleProgressBarClick}
            onKeyDown={(e) => {
              const step = 0.05;
              if (e.key === "ArrowRight") {
                e.preventDefault();
                seek(Math.min(1, progress + step));
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                seek(Math.max(0, progress - step));
              }
            }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <div
              className="pointer-events-none absolute inset-y-0 top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-[hsl(32,100%,50%)]"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          <button
            onClick={restart}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 transition-colors hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            aria-label="Restart"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
