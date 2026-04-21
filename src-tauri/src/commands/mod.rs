//! Comandos expuestos al frontend vía `invoke()`.
//!
//! Regla: los archivos de este módulo son thin wrappers — reciben args,
//! llaman a los módulos de dominio (`db`, `audio`, `downloader`, `lyrics`),
//! mapean errores a `AppError`. La lógica vive en los módulos, no acá.
//!
//! Ver docs/ARCHITECTURE.md §3 para los contratos y §5 para la estructura.
