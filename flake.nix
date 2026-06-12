{
  description = "GNOME Shell extension: DBus Property Pulse";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      uuid = "dbus-pulse@dev.gourves.net";
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = "gnome-shell-extension-dbus-pulse";
          version = "2";
          src = self;

          # glib-compile-schemas lives in glib's bin.
          nativeBuildInputs = [ pkgs.glib ];

          # Compile the bundled GSettings schema.
          buildPhase = ''
            runHook preBuild
            glib-compile-schemas --strict schemas
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            dir="$out/share/gnome-shell/extensions/${uuid}"
            install -d "$dir"
            cp -r . "$dir"
            # Nix packaging files don't belong in the shipped extension.
            rm -f "$dir"/flake.nix "$dir"/flake.lock
            runHook postInstall
          '';

          passthru.extensionUuid = uuid;

          meta.platforms = systems;
        };
      });
    };
}
