//! Key and stream names under a prefix (BUS-NAT-RS-006).
use crate::frame::Direction;

// @spec BUS-NAT-RS-006

#[derive(Debug, Clone)]
pub struct Keys {
    prefix: String,
}

impl Keys {
    pub fn new(prefix: &str) -> Self {
        Keys {
            prefix: prefix.to_string(),
        }
    }
    /// `<prefix>:events`
    pub fn events(&self) -> String {
        format!("{}:events", self.prefix)
    }
    /// `<prefix>:health`
    pub fn health(&self) -> String {
        format!("{}:health", self.prefix)
    }
    /// `<prefix>:upload:<id>`
    pub fn upload(&self, id: &str) -> String {
        format!("{}:upload:{id}", self.prefix)
    }
    /// `<prefix>:connector:<id>`
    pub fn connector(&self, id: &str) -> String {
        format!("{}:connector:{id}", self.prefix)
    }
    /// `<prefix>:audio.<dir>.<tag>`
    pub fn audio(&self, dir: Direction, tag: &str) -> String {
        format!("{}:audio.{}.{tag}", self.prefix, dir.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // @spec BUS-NAT-RS-006
    #[test]
    fn names_under_the_prefix() {
        let k = Keys::new("cohost");
        assert_eq!(k.events(), "cohost:events");
        assert_eq!(k.health(), "cohost:health");
        assert_eq!(k.upload("u1"), "cohost:upload:u1");
        assert_eq!(k.connector("discord"), "cohost:connector:discord");
        assert_eq!(k.audio(Direction::In, "mic"), "cohost:audio.in.mic");
        assert_eq!(k.audio(Direction::Out, "spk"), "cohost:audio.out.spk");
        assert_eq!(Keys::new("t-1").events(), "t-1:events");
    }
}
