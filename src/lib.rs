mod bilibili;
mod client;
mod douyin;
mod endpoint;
mod protocol;
mod server;
mod service;
mod service_cli;
mod standalone_service;
mod supervisor;
mod xhs;
mod youtube;

pub use client::{ServiceClient, ServiceClientError};
pub use endpoint::{read_endpoint, write_endpoint, Endpoint};
pub use protocol::{
    negotiate, ErrorEnvelope, HandshakeRequest, ServiceCapabilities, ServiceError,
    ServiceHandshake, ServiceHandshakeResponse, ServiceReply, ServiceRequest, APP_ID, DATA_API,
    HOST_API, SERVICE_API,
};
pub use server::ServiceServer;
pub use service::VideoService;
pub use service_cli::{parse_service_args, ServiceRunOptions};
pub use standalone_service::StandaloneService;
pub use supervisor::{
    CommandServiceLauncher, ServiceLaunchSpec, ServiceLauncher, ServiceProcess, ServiceSupervisor,
    ServiceSupervisorError,
};
