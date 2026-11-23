//! Flags and environment of the helper (EARS-SRC-015, EARS-SRC-017, EARS-SRC-018, EARS-SRC-021).

use std::fmt;
use std::str::FromStr;

use crate::clip::ClipConfig;
use crate::post::{DEFAULT_URL, resolve_token};

pub const DEFAULT_REDIS_URL: &str = "redis://127.0.0.1:6379";
pub const DEFAULT_PREFIX: &str = "cohost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub url: String,
    pub redis_url: String,
    pub prefix: String,
    pub clip: ClipConfig,
    pub token: Option<String>,
    pub device: Option<String>,
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

impl Options {
    /// Parses `args` (without the program name). `env` holds `REDIS_URL` and `EARS_HTTP_TOKEN`
    /// when set; a flag wins over the environment and an empty value counts as unset.
    // @spec EARS-SRC-015, EARS-SRC-017, EARS-SRC-018, EARS-SRC-021
    pub fn parse(args: &[&str], env: &[(&str, &str)]) -> Result<Self, UsageError> {
        let mut url = DEFAULT_URL.to_string();
        let mut prefix = DEFAULT_PREFIX.to_string();
        let mut redis_flag = None;
        let mut token_flag = None;
        let mut device = None;
        let mut clip = ClipConfig::default();

        let mut rest = args.iter().copied();
        while let Some(flag) = rest.next() {
            let mut value = || {
                rest.next()
                    .map(str::to_string)
                    .ok_or_else(|| UsageError(format!("{flag} needs a value")))
            };
            match flag {
                "--url" => url = value()?,
                "--redis-url" => redis_flag = Some(value()?),
                "--prefix" => prefix = value()?,
                "--silence-ms" => clip.silence_ms = number(flag, &value()?)?,
                "--max-clip-ms" => clip.max_clip_ms = number(flag, &value()?)?,
                "--silence-level" => clip.silence_level = number(flag, &value()?)?,
                "--token" => token_flag = Some(value()?),
                "--device" => device = Some(value()?).filter(|d: &String| !d.is_empty()),
                other => return Err(UsageError(format!("unknown option {other}"))),
            }
        }

        let redis_url = redis_flag
            .filter(|u| !u.is_empty())
            .or_else(|| env_value(env, "REDIS_URL").filter(|u| !u.is_empty()))
            .unwrap_or_else(|| DEFAULT_REDIS_URL.to_string());
        let token = resolve_token(token_flag, env_value(env, "EARS_HTTP_TOKEN"));
        Ok(Self {
            url,
            redis_url,
            prefix,
            clip,
            token,
            device,
        })
    }
}
