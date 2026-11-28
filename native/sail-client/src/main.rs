#[cfg(not(target_arch = "wasm32"))]
fn main() {
    sail_client::run_native();
}

#[cfg(target_arch = "wasm32")]
fn main() {}
