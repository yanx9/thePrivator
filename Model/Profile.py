import json
from utils import get_random_ua
class Profile:
    def __init__(self, rc_port, name="New", chromium_version="116", user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/45.0.2454.85 Safari/537.36",
                  proxy_flag=0, proxy_url="", proxy_user="", proxy_pass="",
                  auth_flag=0, proxy_port=""):
        self.name = name
        self.chromium_version = chromium_version
        self.user_agent = user_agent
        self.proxy_flag = proxy_flag
        self.proxy_url = proxy_url
        self.proxy_user = proxy_user
        self.proxy_pass = proxy_pass
        self.auth_flag = auth_flag
        self.proxy_port = proxy_port
        self.rc_port = rc_port
        
    def dump_config(self):
        return json.dumps(self.__dict__, indent = 4)
    
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