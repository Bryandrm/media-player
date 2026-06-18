//! Tipo de error unificado para todos los comandos Tauri.
//!
//! Los comandos devuelven `AppResult<T>` = `Result<T, AppError>`. Al fallar,
//! `AppError` se serializa como string plano al frontend — el frontend no
//! necesita discriminar variantes, solo mostrar el mensaje.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    // Identification (AcoustID + Chromaprint). fpcalc se invoca como child
    // process y puede fallar de tres maneras distintas; las separamos para
    // que el frontend muestre mensajes claros (vs un error genérico).
    #[error("fpcalc failed: {0}")]
    FpcalcFailed(String),

    #[error("fpcalc output parse error: {0}")]
    FpcalcParse(String),

    #[error("AcoustID API error: {0}")]
    AcoustIdApi(String),

    #[error("AcoustID API key not configured — set it in Settings")]
    AcoustIdNoApiKey,

    // Key presente pero rechazada por AcoustID (código 4). Distinta de
    // NoApiKey: acá hay una key seteada pero inválida (typo, o pegaron la
    // "user API key" en vez de la "application API key"). El frontend la usa
    // para reabrir el modal y que el usuario la corrija.
    #[error("AcoustID API key is invalid — get an Application API key at acoustid.org/new-application")]
    AcoustIdInvalidKey,

    // Karaoke (forced alignment via WhisperX).
    #[error("whisperx not installed — install via: pipx install whisperx")]
    WhisperxMissing,

    #[error("whisperx alignment failed: {0}")]
    WhisperxFailed(String),

    #[error("whisperx output parse error: {0}")]
    WhisperxParse(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
