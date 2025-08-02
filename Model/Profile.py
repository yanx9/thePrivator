from dataclasses import dataclass, asdict
import json


@dataclass
class Profile:
    rc_port: int
    name: str = "New"
    chromium_version: str = "116"
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_5) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/45.0.2454.85 Safari/537.36"
    )
    proxy_flag: int = 0
    proxy_url: str = ""
    proxy_user: str = ""
    proxy_pass: str = ""
    auth_flag: int = 0
    proxy_port: str = ""

    def dump_config(self) -> str:
        """Return profile data as formatted JSON string."""
        return json.dumps(asdict(self), indent=4)
    
# if __name__ == "__main__":
#     profile = Profile(
#         "test", 
#         "116", 
#         "Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.130 Safari/537.36",
#         False,
#         "",
#         "",
#         ""
#         )
#     print(profile.dump_config())