-- Initial schema for Brutalist Player
-- Referencia: docs/PLAN-reproductor-brutalist.md §3.1

PRAGMA foreign_keys = ON;

CREATE TABLE tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_ms INTEGER NOT NULL,
    track_number INTEGER,
    year INTEGER,
    genre TEXT,
    cover_art_path TEXT,
    source_url TEXT,
    source_type TEXT NOT NULL,
    bitrate INTEGER,
    sample_rate INTEGER,
    format TEXT,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played_at DATETIME,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE lyrics (
    track_id INTEGER PRIMARY KEY,
    synced_lyrics TEXT,
    plain_lyrics TEXT,
    source TEXT,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    error_message TEXT,
    track_id INTEGER,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_album ON tracks(album);
CREATE INDEX idx_tracks_added ON tracks(added_at DESC);
