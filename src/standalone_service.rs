use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::{ServiceClient, ServiceSupervisor, ServiceSupervisorError};

pub struct StandaloneService {
    supervisor: Mutex<ServiceSupervisor>,
    client: RwLock<Option<Arc<ServiceClient>>>,
}

impl StandaloneService {
    pub fn new(supervisor: ServiceSupervisor) -> Self {
        Self {
            supervisor: Mutex::new(supervisor),
            client: RwLock::new(None),
        }
    }

    pub async fn connect(&self) -> Result<(), ServiceSupervisorError> {
        let client = Arc::new(self.supervisor.lock().await.connect().await?);
        *self.client.write().await = Some(client);
        Ok(())
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ServiceSupervisorError> {
        let client = self.client.read().await.clone().ok_or_else(|| {
            ServiceSupervisorError::new(
                "VIDEO_SERVICE_NOT_CONNECTED",
                "video service has not been connected",
            )
        })?;
        client.request(method, params).await.map_err(Into::into)
    }
}
