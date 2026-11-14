//! Key and stream names under a prefix (BUS-NAT-RS-006).
use crate::frame::Direction;

#[derive(Debug, Clone)]
pub struct Keys {
    prefix: String,
}

impl Keys {
    pub fn new(prefix: &str) -> Self {
        todo!("BUS-NAT-RS-006")
    }
    /// `<prefix>:events`
    pub fn events(&self) -> String {
        todo!()
    }
    /// `<prefix>:health`
    pub fn health(&self) -> String {
        todo!()
    }
    /// `<prefix>:upload:<id>`
    pub fn upload(&self, id: &str) -> String {
        todo!()
    }
    /// `<prefix>:connector:<id>`
    pub fn connector(&self, id: &str) -> String {
        todo!()
    }
    /// `<prefix>:audio.<dir>.<tag>`
    pub fn audio(&self, dir: Direction, tag: &str) -> String {
        todo!()
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
