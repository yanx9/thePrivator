import os
from Model.Profile import Profile
from core import Core
def get_folder_size(folder_path):
    total_size = 0

    for dirpath, dirnames, filenames in os.walk(folder_path):
        for filename in filenames:
            filepath = os.path.join(dirpath, filename)
            try:
                total_size += os.path.getsize(filepath)
            except(FileNotFoundError):
                continue
    scale = "B"
    if total_size < 1024:
        return f"{total_size} B"
    elif total_size < 1048576:
        return f"{round(total_size/1024)} kB"
    else:
        return f"{round(total_size/1048576)} MB"


def get_profile_path(profile) -> str:
    return os.path.join(os.getcwd(), Core().user_data_root, profile.name)
    