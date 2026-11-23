//! The Redis registry for the helper's connector key, through `cohost-bus` (CONN-REG-001,
//! CONN-DESK-004). The key is `<prefix>:connector:desktop`.

use cohost_bus::{Transport, TransportOptions};

use crate::registration::RegistryStore;

pub struct BusRegistry {
    transport: Transport,
}

impl BusRegistry {
    /// Begins connecting to `url` under `prefix`. Must run inside a tokio runtime. Writes fail
    /// fast while Redis is down, so the registrar's retry drives the timing.
    pub fn connect(url: &str, prefix: &str) -> Self {
        let transport = Transport::new(
            url,
            TransportOptions {
                prefix: prefix.to_string(),
                fail_fast: true,
            },
        );
        Self { transport }
    }
}

impl RegistryStore for BusRegistry {
    async fn write_registration(&self, id: &str, json: &str, lease_ms: u64) -> Result<(), String> {
        self.transport
            .write_registration(id, json, lease_ms)
            .await
            .map_err(|e| e.to_string())
    }

    async fn read_registration(&self, id: &str) -> Result<Option<String>, String> {
        self.transport
            .read_registration(id)
            .await
            .map_err(|e| e.to_string())
    }

    async fn delete_registration(&self, id: &str) -> Result<(), String> {
        self.transport
            .delete_registration(id)
            .await
            .map_err(|e| e.to_string())
    }
}
