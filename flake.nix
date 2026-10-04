{
  description = "saavy cloud: the brain on Cloudflare (PiHarness), tools on a desktop runner";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        # cf needs Node >= 22.18 to load cloudflare.config.ts.
        packages = with pkgs; [ nodejs_24 ];

        # workerd (cf dev) has no default trust store on NixOS; without this, remote bindings fail TLS.
        # nix develop strips SSL_CERT_FILE from the build env, so export it from the hook.
        shellHook = ''
          export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          export NODE_EXTRA_CA_CERTS=$SSL_CERT_FILE
        '';
      };
    };
}
