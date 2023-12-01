import json
class Profile:
    def __init__(self, name="New", chromium_version="116", user_agent="Default", proxy_flag=0, proxy_url="", proxy_user="", proxy_pass=""):
        self.name = name
        self.chromium_version = chromium_version
        self.user_agent = user_agent
        self.proxy_flag = proxy_flag
        self.proxy_url = proxy_url
        self.proxy_user = proxy_user
        self.proxy_pass = proxy_pass
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