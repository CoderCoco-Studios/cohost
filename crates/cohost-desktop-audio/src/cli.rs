//! Flags and environment of the helper (EARS-SRC-015, EARS-SRC-017, EARS-SRC-018, EARS-SRC-021).

use std::fmt;
use std::str::FromStr;

use crate::clip::ClipConfig;
use crate::post::{DEFAULT_URL, listener_key, parse_http_target, resolve_token};

pub const DEFAULT_REDIS_URL: &str = "redis://127.0.0.1:6379";
pub const DEFAULT_PREFIX: &str = "cohost";
/// Upper bounds on the clip cut. A silence longer than 10 s never closes a useful clip, and a clip
/// over 60 s is far past what ears transcribes in one request.
pub const MAX_SILENCE_MS: u32 = 10_000;
pub const MAX_CLIP_MS: u32 = 60_000;
/// The largest magnitude a sample can have is 32768; a level above 32767 makes nothing audible.
pub const MAX_SILENCE_LEVEL: u16 = 32_767;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub url: String,
    pub redis_url: String,
    pub prefix: String,
    pub clip: ClipConfig,
    /// The ears listener key derived from the control token: the bearer of every `POST /audio`.
    pub key: String,
    pub device: Option<String>,
    /// Problems that do not stop the helper, for the caller to log.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(String);

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UsageError {}

fn env_value(env: &[(&str, &str)], key: &str) -> Option<String> {
    env.iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_string())
}

fn number<T: FromStr>(flag: &str, raw: &str) -> Result<T, UsageError> {
    raw.parse()
        .map_err(|_| UsageError(format!("{flag} needs a number, got {raw:?}")))
}

fn bounded(flag: &str, value: u32, min: u32, max: u32) -> Result<u32, UsageError> {
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(UsageError(format!(
            "{flag} must be between {min} and {max}, got {value}"
        )))
    }
}

impl Options {
    /// Parses `args` (without the program name). `env` holds `REDIS_URL` and `CONTROL_TOKEN`
    /// when set; a flag wins over the environment and an empty value counts as unset. Any
    /// problem, a missing token included, is a [`UsageError`], so the helper exits before it
    /// captures or posts anything.
    // @spec EARS-SRC-015, EARS-SRC-017, EARS-SRC-018, EARS-SRC-021
    pub fn parse(args: &[&str], env: &[(&str, &str)]) -> Result<Self, UsageError> {
        let mut url = DEFAULT_URL.to_string();
        let mut prefix = DEFAULT_PREFIX.to_string();
        let mut redis_flag = None;
        let mut token_flag = None;
        let mut allow_remote = false;
        let mut device = None;
        let mut clip = ClipConfig::default();

        let mut rest = args.iter().copied();
        while let Some(flag) = rest.next() {
            if flag == "--allow-remote" {
                allow_remote = true;
                continue;
            }
            let mut value = || {
                rest.next()
                    .map(str::to_string)
                    .ok_or_else(|| UsageError(format!("{flag} needs a value")))
            };
            match flag {
                "--url" => url = value()?,
                "--redis-url" => redis_flag = Some(value()?),
                "--prefix" => prefix = value()?,
                "--silence-ms" => {
                    let v = number(flag, &value()?)?;
                    clip.silence_ms = bounded(flag, v, 1, MAX_SILENCE_MS)?;
                }
                "--max-clip-ms" => {
                    let v = number(flag, &value()?)?;
                    clip.max_clip_ms = bounded(flag, v, 1, MAX_CLIP_MS)?;
                }
                "--silence-level" => {
                    let v: u16 = number(flag, &value()?)?;
                    if v > MAX_SILENCE_LEVEL {
                        return Err(UsageError(format!(
                            "{flag} must be at most {MAX_SILENCE_LEVEL}, got {v}"
                        )));
                    }
                    clip.silence_level = v;
                }
                "--token" => token_flag = Some(value()?),
                "--device" => device = Some(value()?).filter(|d: &String| !d.is_empty()),
                other => return Err(UsageError(format!("unknown option {other}"))),
            }
        }

        if prefix.is_empty() {
            return Err(UsageError("--prefix must not be empty".into()));
        }
        let target = parse_http_target(&url).map_err(|e| UsageError(format!("--url: {e}")))?;

        let redis_url = redis_flag
            .filter(|u| !u.is_empty())
            .or_else(|| env_value(env, "REDIS_URL").filter(|u| !u.is_empty()))
            .unwrap_or_else(|| DEFAULT_REDIS_URL.to_string());
        let Some(token) = resolve_token(token_flag, env_value(env, "CONTROL_TOKEN")) else {
            return Err(UsageError(
                "no control token: set CONTROL_TOKEN to the value in cohost's .env (or pass --token)"
                    .into(),
            ));
        };
        if token.contains(['\r', '\n']) {
            return Err(UsageError("the token must not contain a line break".into()));
        }

        let mut warnings = Vec::new();
        if !target.is_loopback() {
            if !allow_remote {
                return Err(UsageError(format!(
                    "--url names {}, which is not a loopback address: the listener key would cross the network in clear text over http; pass --allow-remote to send it anyway",
                    target.host
                )));
            }
            warnings.push(format!(
                "--url is not a loopback address: the listener key travels unencrypted to {} over http",
                target.host
            ));
        }
        Ok(Self {
            url,
            redis_url,
            prefix,
            clip,
            key: listener_key(&token),
            device,
            warnings,
        })
    }
}
