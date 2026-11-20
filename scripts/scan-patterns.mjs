// Secret and personal-path patterns shared by the working-tree verifier and
// the staged-blob pre-commit scan.
export const PATTERNS = [
    { name: 'personal-home', regex: /\/home\/administrator/ },
    { name: 'windows-user-path', regex: /\/mnt\/c\/Users\/Administrator|C:\\Users\\/ },
    { name: 'device-serial', regex: new RegExp('f17d' + '679d') },
    { name: 'device-model', regex: new RegExp('PDE' + 'M10|OP4' + 'A7B') },
    { name: 'eval-project-id', regex: new RegExp('claude-mobile-' + 'eval|deepseek-phone-' + 'p1|final-target-' + '06|night-' + '1111') },
    { name: 'sk-token', regex: /sk-[A-Za-z0-9_-]{16,}/ },
    { name: 'cloud-key', regex: /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[bp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}/ },
    { name: 'private-key', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
];
