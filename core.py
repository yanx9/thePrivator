import platform
import os
import subprocess
from Model.Profile import Profile
import shlex, shutil
import json
from pathlib import Path

class Core():
    def __init__(self):
        self.user_data_root = "Profiles"
        self.loaded_profiles = []
        self.settings = self.getSettings()
        self.chromium_path = self.settings["chromiumPath"]
        if self.chromium_path == "":
            if platform.system() == 'Windows':
                self.settings.update({"chromiumPath": 'E:\Studia\Praca\thePrivator\chrome-win\chrome.exe'})
            else:
                self.settings.update({"chromiumPath": "/home/homebrew/bin/chromium"})

        self.active_processes = {}
        self.load_profiles()
        print(platform.system())

    def load_profiles(self):
        loaded_profiles = []
        for root, dirs, files in os.walk("Profiles"):
            for filename in files:
                if filename == 'config.json':
                    config_path = os.path.join(root, filename)
                    
                    # Load the JSON data from the config file
                    with open(config_path, 'r') as config_file:
                        config_data = json.load(config_file)
    # Create a Profile object from the loaded JSON data
                    profile = Profile(
                        config_data['rc_port'],
                        config_data['name'],
                        config_data['chromium_version'],
                        config_data['user_agent'],
                        config_data['proxy_flag'],
                        config_data['proxy_url'],
                        config_data['proxy_user'],
                        config_data['proxy_pass'],
                        config_data['auth_flag'],
                        config_data['proxy_port']
                    )

                    # Append the Profile object to the loaded_profiles list
                    loaded_profiles.append(profile)

        self.loaded_profiles = loaded_profiles

    def get_next_rc_port(self) -> int:
        ports = []
        for profile in self.loaded_profiles:
            ports.append(profile.rc_port)
        ports.sort()
        p = 9222
        print(ports[p-9222])
        while p <= ports[-1] and p == ports[p-9222]:
            p += 1
        return p

    def getSettings(self):
        settingsPath = Path(f"{os.getcwd()}/Model/settings.json")
        print(settingsPath)
        with open(settingsPath, 'r') as settings_file:
            #print(settings_file.read())
            return json.load(settings_file)
    
    def setSettings(self, settingsDict):
        settingsPath = Path(f"{os.getcwd()}/Model/settings.json")
        with open(settingsPath, 'w') as settings:
            settings.write(json.dumps(settingsDict))

    def update_prof_list(self):
        self.loaded_profiles = self.load_profiles()

    def craft_command(self, profile:Profile):
        args = self.settings["chromiumPath"]
        if profile.user_agent != "":
            args += f" --user-agent='{profile.user_agent}'"
        if profile.proxy_flag == 1:
            if profile.auth_flag == 1: 
                args += f" --proxy-server=http://{profile.proxy_user}:{profile.proxy_pass}@{profile.proxy_url}:{profile.proxy_port}"
            elif profile.auth_flag == 0:
                args += f" --proxy-server=http://{profile.proxy_url}:{profile.proxy_port}"
            
        datadir = Path(f"{os.getcwd()}/Profiles/{profile.name}/user-data")
        args += f" --user-data-dir='{datadir}' --remote-debugging-port={profile.rc_port}"
        return args

    def new_profile(self, profile:Profile):
        if not os.path.exists(Path(self.user_data_root)):
            os.mkdir(os.path.join(os.getcwd(), self.user_data_root))
        if not os.path.exists(Path(f"Profiles/{profile.name}")):
            os.mkdir(os.path.join(os.getcwd(), self.user_data_root, profile.name))
            os.mkdir(os.path.join(os.getcwd(), self.user_data_root, profile.name, "user-data"))
            with open(os.path.join(os.getcwd(), self.user_data_root, profile.name, "config.json"), 'w') as file:
            # Step 2: Write data to the file
                file.write(profile.dump_config())
        else:
            print("Profile with this name already exists!")
            return 1
        self.update_prof_list()
        return 0

    def edit_profile(self, oldProfile:Profile, newProfile:Profile):
        # print(oldProfile.name, newProfile.name, oldProfile.user_agent, newProfile.user_agent)
        # if os.path.exists(Path(f"Profiles/{newProfile.name}")):
        #     print("Profile with this name already exists!")
        #     return 1
        if oldProfile.name != newProfile.name and os.path.exists(os.path.join(os.getcwd(), "Profiles", newProfile.name)):
            print("No to lipa")
            pass
        print(oldProfile.name, newProfile.name)

        print(os.path.join(os.getcwd(), self.user_data_root, newProfile.name))
        os.rename(os.path.join(os.getcwd(), self.user_data_root, oldProfile.name),
                    os.path.join(os.getcwd(), self.user_data_root, newProfile.name))
        with open(os.path.join(os.getcwd(), self.user_data_root,
                                newProfile.name, "config.json"), 'w') as file:
            # Step 2: Write data to the file
            file.write(newProfile.dump_config())
        return 0
    
    def delete_profile(self, profile:Profile):
        if os.path.exists(os.path.join(f"{self.user_data_root}", f"{profile.name}")):
            shutil.rmtree(os.path.join(os.getcwd(), f"{self.user_data_root}", profile.name))
        self.update_prof_list()

    def run_profile(self, profile:Profile):
        self.settings = self.getSettings()
        command_line = self.craft_command(profile=profile)
        if platform.system() == 'Windows':
            args = command_line
        else:
            args = shlex.split(command_line)
        
        print(args)

        proc = subprocess.Popen(args)
        self.active_processes.update({profile.name: proc})

    def stop_profile(self, profile:Profile):
        self.active_processes[profile.name].terminate()
        self.active_processes.pop(profile.name)

    def check_running_processes(self):
        for instance in self.active_processes:
            if self.active_processes[instance].poll() is None:
                self.active_processes.pop(instance)
                



# Create a new Chrome profile each time
# TODO os.system("/opt/homebrew/bin/chromium --proxy-server=socks5://142.54.237.34:4145 --user-agent='XD' --user-data-dir='Profiles/Name'")
# shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE - NOTE
# Check the result and print the output
# Perform actions or automation tasks
# ...

# Close the Chromium instance
#driver.quit()