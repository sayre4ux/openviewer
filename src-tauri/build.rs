fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "read_document", "write_document", "create_document_window", "frontend_ready",
      "sync_view_menu", "open_dialog", "save_dialog", "resolve_image_path", "allow_image_folder", "insert_image", "insert_dropped_image",
      "get_settings", "set_settings", "export_dialog", "export_html", "export_pdf", "export_image", "get_keybindings",
      "set_keybindings", "open_keybindings_file", "suspend_shortcuts", "open_linked_document", "update_quit_response",
    ]),
  )).expect("failed to build Tauri app manifest")
}
