import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { usePlayerStore } from "../../stores/playerStore";
import {
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  formatSampleRate,
} from "../../lib/format";
import type { TrackDetails } from "../../types";

// Panel del sidebar que inspecciona el track actual. Auto-sigue al
// `currentTrackId` del playerStore — cuando el usuario clickea otro track en
// la library (= lo pone a sonar), el panel se actualiza solo.
//
// Estructura (de arriba a abajo):
//   - Cover art full-width (fallback a placeholder si no hay).
//   - Header con título + artist.
//   - Bloques con dividers brutalist: TRACK, TECH, PLAYBACK, EXTERNAL, SOURCE.
//
// Sin track seleccionado → "NO TRACK SELECTED" centrado.

export function TrackDetailsPanel() {
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const [details, setDetails] = useState<TrackDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refetch cada vez que cambia el currentTrackId. Race-guard simple: si el
  // usuario cambia de track mientras un fetch está en vuelo, descartamos el
  // resultado viejo (forTrackId al inicio + check al volver).
  useEffect(() => {
    if (currentTrackId === null) {
      setDetails(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const targetId = currentTrackId;
    setLoading(true);
    setError(null);
    invoke<TrackDetails | null>("library_get_track_details", {
      trackId: targetId,
    })
      .then((result) => {
        if (cancelled || targetId !== currentTrackId) return;
        setDetails(result);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || targetId !== currentTrackId) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTrackId]);

  if (currentTrackId === null) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 text-center text-muted text-xs uppercase tracking-wider">
        NO TRACK SELECTED
        <br />
        PICK ONE FROM THE LIBRARY
      </div>
    );
  }

  if (loading && !details) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-xs uppercase tracking-wider">
        LOADING…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 px-4 py-3 text-accent text-xs uppercase tracking-wider">
        ERROR: {error}
      </div>
    );
  }

  if (!details) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-xs uppercase tracking-wider">
        TRACK NOT FOUND
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
      {/* Cover full width (cuadrado, sidebar es w-56 = 224px). Fallback a un
          placeholder bordeado si no hay imagen. */}
      <CoverBlock path={details.coverArtPath} />

      <div className="px-4 py-3 flex flex-col gap-3 text-xs">
        {/* Título + artista en el header (font-display = Space Grotesk para
            destacar del resto que es mono). */}
        <div>
          <div className="text-fg text-sm font-bold leading-tight font-display">
            {details.title}
          </div>
          {details.artist && (
            <div className="text-muted text-xs mt-0.5">{details.artist}</div>
          )}
        </div>

        {/* TRACK */}
        <Section title="TRACK">
          <KV label="ALBUM" value={details.album} />
          <KV
            label="YEAR / GENRE"
            value={
              details.year || details.genre
                ? [
                    details.year ? String(details.year) : null,
                    details.genre ? details.genre.toUpperCase() : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
          />
          <KV
            label="TRACK NUMBER"
            value={details.trackNumber !== null ? String(details.trackNumber) : null}
          />
          <KV label="LYRICS" value={mapLyricsStatus(details.lyricsStatus)} />
        </Section>

        {/* TECH */}
        <Section title="TECH">
          <KV
            label="FORMAT"
            value={details.format ? details.format.toUpperCase() : null}
          />
          <KV
            label="BITRATE"
            value={details.bitrate ? `${details.bitrate} KBPS` : null}
          />
          <KV
            label="SAMPLE RATE"
            value={
              details.sampleRate ? formatSampleRate(details.sampleRate) : null
            }
          />
          <KV label="DURATION" value={formatDuration(details.durationMs)} />
          <KV label="FILE SIZE" value={formatFileSize(details.fileSizeBytes)} />
        </Section>

        {/* PLAYBACK — hoy estos campos no se actualizan (gap conocido); los
            mostramos igual para que cuando se implemente el tracking aparezca
            sin tocar UI. */}
        <Section title="PLAYBACK">
          <KV label="PLAY COUNT" value={String(details.playCount)} />
          <KV
            label="LAST PLAYED"
            value={
              details.lastPlayedAt ? formatRelativeTime(details.lastPlayedAt) : "NEVER"
            }
          />
          <KV label="ADDED" value={formatRelativeTime(details.addedAt)} />
        </Section>

        {/* EXTERNAL */}
        <Section title="EXTERNAL">
          <KV
            label="MBID"
            value={details.mbidRecording}
            mono
            wrap
            copyable
          />
          <KV
            label="ACOUSTID"
            value={
              details.acoustidId
                ? `${details.acoustidId.slice(0, 8)}… (${(
                    (details.acoustidScore ?? 0) * 100
                  ).toFixed(0)}%)`
                : null
            }
            mono
          />
          <KV
            label="ID STATUS"
            value={
              details.identificationStatus
                ? details.identificationStatus.toUpperCase()
                : null
            }
          />
        </Section>

        {/* SOURCE */}
        <Section title="SOURCE">
          <KV label="TYPE" value={details.sourceType.toUpperCase()} />
          {details.sourceUrl && (
            <KV label="URL" value={details.sourceUrl} wrap mono copyable />
          )}
          <KV label="PATH" value={details.filePath} wrap mono copyable />
        </Section>
      </div>
    </div>
  );
}

function CoverBlock({ path }: { path: string | null }) {
  if (!path) {
    return (
      <div className="w-full aspect-square border-b-2 border-fg flex items-center justify-center bg-bg text-muted text-[10px] uppercase tracking-wider">
        NO COVER
      </div>
    );
  }
  return (
    <div className="w-full aspect-square border-b-2 border-fg bg-bg">
      <img
        src={convertFileSrc(path)}
        alt=""
        className="w-full h-full object-cover"
        // Sin draggable para evitar interferencia con el drag de las playlists.
        draggable={false}
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="border-t-2 border-fg pt-1.5 text-[10px] font-bold tracking-wider text-muted uppercase">
        {title}
      </div>
      {children}
    </section>
  );
}

function KV({
  label,
  value,
  mono = false,
  wrap = false,
  copyable = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  wrap?: boolean;
  copyable?: boolean;
}) {
  // Tracks que no tienen el campo → "—" en muted. Más útil que ocultarlo;
  // así el usuario ve qué le falta a un track específico.
  const display = value && value.trim() !== "" ? value : "—";
  const onClick =
    copyable && value
      ? () => {
          void navigator.clipboard.writeText(value).catch(() => {});
        }
      : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted uppercase tracking-wider">
        {label}
      </span>
      <span
        onClick={onClick}
        title={copyable && value ? "Click to copy" : undefined}
        className={`text-fg text-xs ${mono ? "font-mono" : ""} ${
          wrap ? "break-all" : "truncate"
        } ${copyable && value ? "cursor-pointer hover:text-accent" : ""} ${
          display === "—" ? "text-muted" : ""
        }`}
      >
        {display}
      </span>
    </div>
  );
}

function mapLyricsStatus(status: string | null): string | null {
  if (!status) return null;
  switch (status) {
    case "aligned":
      return "SYNCED (KARAOKE ALIGNED)";
    case "synced":
      return "SYNCED";
    case "plain":
      return "PLAIN ONLY";
    case "instrumental":
      return "INSTRUMENTAL";
    case "not_found":
      return "NOT FOUND";
    default:
      return status.toUpperCase();
  }
}
