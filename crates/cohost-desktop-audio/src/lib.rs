//! The desktop audio capture helper (EARS-SRC-014 to EARS-SRC-023, CONN-DESK-001/004/005).
//!
//! This crate is the pure core: clip cutting, PCM conversion, the HTTP post, the delivery
//! queue and retry, the connector registration, command-line parsing, source selection and
//! the stop sequence. Platform capture back ends sit behind [`source::Capture`].

pub mod app;
pub mod backend;
pub mod cli;
pub mod clip;
pub mod deliver;
pub mod lifecycle;
pub mod pcm;
pub mod post;
pub mod redis_registry;
pub mod registration;
pub mod retry;
pub mod session;
pub mod source;
