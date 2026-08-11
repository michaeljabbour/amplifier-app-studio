#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = amplifier_studio_lib::web_server::run_from_env().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
