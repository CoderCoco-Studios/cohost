//! Key and stream names under a prefix (BUS-NAT-RS-006).

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
        assert_eq!(Keys::new("t-1").events(), "t-1:events");
    }
}
