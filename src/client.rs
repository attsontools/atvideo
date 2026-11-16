use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{tcp::OwnedWriteHalf, TcpStream},
    sync::{oneshot, Mutex as AsyncMutex},
    time::{timeout, Duration},
};
use uuid::Uuid;

use crate::{
    read_endpoint, HandshakeRequest, ServiceHandshake, ServiceReply, ServiceRequest, APP_ID,
    DATA_API, HOST_API, SERVICE_API,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceClientError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ServiceClientError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for ServiceClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceClientError {}

type PendingResult = Result<Value, ServiceClientError>;

fn service_request_timeout() -> Duration {
    Duration::from_secs(35)
}

#[derive(Default)]
struct ClientState {
    pending: HashMap<String, oneshot::Sender<PendingResult>>,
    disconnected: Option<ServiceClientError>,
}

pub struct ServiceClient {
    writer: Arc<AsyncMutex<OwnedWriteHalf>>,
    state: Arc<Mutex<ClientState>>,
}

impl ServiceClient {
    pub async fn connect(
        endpoint_path: &Path,
        data_directory: &Path,
        client_id: impl Into<String>,
    ) -> Result<Self, ServiceClientError> {
        let endpoint = read_endpoint(endpoint_path)
            .map_err(|error| ServiceClientError::new(error.code, error.message))?;
        let stream = TcpStream::connect(("127.0.0.1", endpoint.port))
            .await
            .map_err(|error| {
                let code = if error.kind() == std::io::ErrorKind::ConnectionRefused {
                    "VIDEO_SERVICE_NOT_RUNNING"
                } else {
                    "VIDEO_SERVICE_CONNECT_FAILED"
                };
                ServiceClientError::new(code, error.to_string())
            })?;
        let (reader, mut writer) = stream.into_split();
        let request_id = Uuid::new_v4().to_string();
        write_json_line(
            &mut writer,
            &ServiceHandshake::Request(HandshakeRequest {
                protocol_version: 1,
                app_id: APP_ID.into(),
                client_id: client_id.into(),
                request_id: request_id.clone(),
                host_api: HOST_API.into(),
                data_api: DATA_API.into(),
                service_api: SERVICE_API.into(),
                data_directory: data_directory.to_string_lossy().into_owned(),
                token: endpoint.token,
            }),
        )
        .await?;
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        timeout(Duration::from_secs(10), reader.read_until(b'\n', &mut line))
            .await
            .map_err(|_| {
                ServiceClientError::new(
                    "VIDEO_SERVICE_HANDSHAKE_TIMEOUT",
                    "video service handshake timed out",
                )
            })?
            .map_err(|error| {
                ServiceClientError::new("VIDEO_SERVICE_HANDSHAKE_FAILED", error.to_string())
            })?;
        match serde_json::from_slice::<ServiceReply>(&line).map_err(|error| {
            ServiceClientError::new("VIDEO_SERVICE_HANDSHAKE_FAILED", error.to_string())
        })? {
            ServiceReply::Handshake(response) if response.request_id == request_id => {}
            ServiceReply::Error { error, .. } => {
                return Err(ServiceClientError {
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                });
            }
            _ => {
                return Err(ServiceClientError::new(
                    "VIDEO_SERVICE_HANDSHAKE_FAILED",
                    "unexpected handshake response",
                ))
            }
        }
        let state = Arc::new(Mutex::new(ClientState::default()));
        tokio::spawn(read_replies(reader, Arc::clone(&state)));
        Ok(Self {
            writer: Arc::new(AsyncMutex::new(writer)),
            state,
        })
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ServiceClientError> {
        let request_id = Uuid::new_v4().to_string();
        let request = ServiceRequest::Request {
            request_id: request_id.clone(),
            method: method.into(),
            params,
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state.lock().expect("client state mutex poisoned");
            if let Some(error) = &state.disconnected {
                return Err(error.clone());
            }
            state.pending.insert(request_id.clone(), sender);
        }
        if let Err(error) = write_json_line(&mut *self.writer.lock().await, &request).await {
            self.state
                .lock()
                .expect("client state mutex poisoned")
                .pending
                .remove(&request_id);
            return Err(error);
        }
        match timeout(service_request_timeout(), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(disconnected()),
            Err(_) => {
                self.state
                    .lock()
                    .expect("client state mutex poisoned")
                    .pending
                    .remove(&request_id);
                Err(ServiceClientError::new(
                    "VIDEO_SERVICE_REQUEST_TIMEOUT",
                    "video service request timed out",
                ))
            }
        }
    }
}

async fn read_replies(
    mut reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
    state: Arc<Mutex<ClientState>>,
) {
    let mut line = Vec::new();
    let error = loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break disconnected(),
            Err(error) => {
                break ServiceClientError::new("VIDEO_SERVICE_DISCONNECTED", error.to_string())
            }
            Ok(_) => {}
        }
        let reply = match serde_json::from_slice::<ServiceReply>(&line) {
            Ok(reply) => reply,
            Err(error) => {
                break ServiceClientError::new("VIDEO_SERVICE_RESPONSE_INVALID", error.to_string())
            }
        };
        match reply {
            ServiceReply::Response { request_id, result } => {
                if let Some(sender) = state
                    .lock()
                    .expect("client state mutex poisoned")
                    .pending
                    .remove(&request_id)
                {
                    let _ = sender.send(Ok(result));
                }
            }
            ServiceReply::Error { request_id, error } => {
                if let Some(sender) = state
                    .lock()
                    .expect("client state mutex poisoned")
                    .pending
                    .remove(&request_id)
                {
                    let _ = sender.send(Err(ServiceClientError {
                        code: error.code,
                        message: error.message,
                        retryable: error.retryable,
                    }));
                }
            }
            ServiceReply::Handshake(_) => {
                break ServiceClientError::new(
                    "VIDEO_SERVICE_RESPONSE_INVALID",
                    "unexpected handshake response",
                )
            }
        }
    };
    let senders = {
        let mut state = state.lock().expect("client state mutex poisoned");
        state.disconnected = Some(error.clone());
        state
            .pending
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>()
    };
    for sender in senders {
        let _ = sender.send(Err(error.clone()));
    }
}

async fn write_json_line<T: serde::Serialize>(
    writer: &mut OwnedWriteHalf,
    value: &T,
) -> Result<(), ServiceClientError> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| {
        ServiceClientError::new("VIDEO_SERVICE_REQUEST_INVALID", error.to_string())
    })?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| ServiceClientError::new("VIDEO_SERVICE_DISCONNECTED", error.to_string()))
}

fn disconnected() -> ServiceClientError {
    ServiceClientError::new(
        "VIDEO_SERVICE_DISCONNECTED",
        "video service connection was closed",
    )
}

#[cfg(test)]
mod tests {
    use super::service_request_timeout;
    use std::time::Duration;

    #[test]
    fn request_timeout_leaves_room_for_platform_timeout_responses() {
        assert_eq!(service_request_timeout(), Duration::from_secs(35));
    }
}
